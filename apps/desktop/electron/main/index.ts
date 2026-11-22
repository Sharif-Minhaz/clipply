import { spawn } from 'node:child_process';
import { app, dialog, BrowserWindow, clipboard, ClipboardItem, globalShortcut, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { initCrypto } from '@clipply/crypto';
import { itemRepo, migrate } from '@clipply/database';
import { openNodeSqlite } from '@clipply/database/node';
import { createLogger } from '@clipply/logger';
import { MAX_THUMB_BYTES } from '@clipply/shared-schemas';
import { AccountController, ClipLibrary, LinkPreviewer, uuidv7 } from '@clipply/sync-engine';

import { CH, type DesktopStatus } from '../shared/api';
import { setAutostart } from './autostart';
import { fileSink } from './logFile';
import { ElectronClipboardProvider, type ClipboardProvider, type DecodedImage } from './clipboard/provider';
import { HelperClipboardProvider } from './clipboard/helper';
import { runClipboardHelper } from './clipboard/helperProcess';
import { DesktopCore, type ClipboardWrite } from './core';
import { activeAppClasses } from './clipboard/activeApp';
import { registerIpc } from './ipc';
import { defaultScreenshotDir, watchScreenshots } from './screenshot/watcher';
import type { Settings } from './settings';
import { GNOME_BINDING, gnomeShortcutInstalled, installGnomeShortcut } from './shortcuts/gnome';
import { createTray } from './tray/tray';
import { openVault, writeVault, type VaultState } from './vault';
import { googleSignIn } from './account/googleOAuth';
import { downloadBlob, sessionStore, uploadBlob } from './account/transport';
import { previewGet } from './preview';
import { hostname } from 'node:os';
import { createMainWindow, showWindow, toggleWindow } from './window/window';

const log = createLogger('main', {
  level: app.isPackaged ? 'info' : 'debug',
  sink: fileSink(join(app.getPath('userData'), 'logs', 'main.log')),
});
const isWaylandSession = process.env.XDG_SESSION_TYPE === 'wayland';
// The window is a native Wayland client (sharp under fractional scaling); background clipboard reads
// need XWayland, so on Wayland they run in a helper process (clipboard/helper.ts, docs/desktop.md).
const useClipboardHelper = process.platform === 'linux' && isWaylandSession && app.commandLine.getSwitchValue('ozone-platform') !== 'x11';

const GLOBAL_SHORTCUT = 'Super+V';

app.setName('Clipply');

/**
 * Inside an AppImage, Electron's relaunch helper runs from the AppImage's mount, which is removed
 * when this process exits, so the helper dies. Start a new, independent AppImage process instead.
 */
const relaunch = (args = process.argv.slice(1)): void => {
  if (process.env.APPIMAGE) spawn(process.env.APPIMAGE, args, { detached: true, stdio: 'ignore' }).unref();
  else app.relaunch({ args });
};

if (process.argv.includes('--clipboard-helper')) {
  app.disableHardwareAcceleration();
  void runClipboardHelper();
} else if (!app.requestSingleInstanceLock()) {
  // A second launch (`clipply --toggle` from a GNOME shortcut) is forwarded to the first instance.
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  await app.whenReady();
  await initCrypto();

  const userData = app.getPath('userData');
  const dbPath = join(userData, 'clipply.db');
  const vaultPath = join(userData, 'vault.v1');
  const appRoot = app.getAppPath();
  const icon = join(appRoot, 'resources', 'icon.png');
  const startHidden = process.argv.includes('--hidden');
  // Absolute: APPIMAGE is the path as typed (relative when launched as ./Clipply…), and the GNOME
  // shortcut and autostart entry run from the home folder.
  const launchCommand = app.isPackaged ? [resolve(process.env.APPIMAGE ?? process.execPath)] : [process.execPath, appRoot];

  // History is ciphertext, but it is still nobody else's business: SQLite gives -wal/-shm the
  // database file's permissions, so the file is created 0600 before SQLite opens it.
  mkdirSync(userData, { recursive: true });
  if (!existsSync(dbPath)) closeSync(openSync(dbPath, 'a', 0o600));
  const db = openNodeSqlite(dbPath);
  await migrate(db);
  const vaultState: VaultState = await openVault(safeStorage, vaultPath, (await itemRepo(db).count()) > 0, () => uuidv7());
  if (vaultState.status !== 'ready') log.warn('vault unavailable', { status: vaultState.status });

  let quitting = false;
  let win: BrowserWindow | null = null;
  let screenshotWatch: { close(): void } | null = null;
  let screenshotDir: string | null = null;
  let globalShortcutActive: string | null = null;

  const decodeImage = (png: Uint8Array): DecodedImage | null => {
    const img = nativeImage.createFromBuffer(Buffer.from(png));
    if (img.isEmpty()) return null;
    const { width } = img.getSize();
    // Busy screenshots compress poorly: step quality, then size, down until the thumbnail fits.
    let thumb = new Uint8Array(0);
    for (const [w, q] of [[320, 80], [320, 60], [240, 60], [180, 50], [120, 50]] as const) {
      thumb = new Uint8Array(img.resize({ width: Math.min(w, width), quality: 'good' }).toJPEG(q));
      if (thumb.length <= MAX_THUMB_BYTES) break;
    }
    return { pixels: new Uint8Array(img.toBitmap()), thumb };
  };

  const provider: ClipboardProvider = useClipboardHelper
    ? new HelperClipboardProvider({
        // execPath (inside the AppImage mount when packaged) lives exactly as long as this process.
        command: [
          ...(app.isPackaged ? [process.execPath] : [process.execPath, appRoot]),
          '--clipboard-helper', '--ozone-platform=x11',
          ...process.argv.filter((a) => a.startsWith('--user-data-dir=')),
        ],
        decodeImage,
        log: log.child('clipboard'),
      })
    : new ElectronClipboardProvider({
        clipboard,
        decodeImage,
        captureImages: () => core?.settings.captureImages ?? false,
        log: log.child('clipboard'),
      });

  const writeClipboard = async (data: ClipboardWrite): Promise<void> => {
    if ('png' in data) {
      // Images added by hand (or JPEG screenshots) may be JPEG/WebP; the clipboard entry must be real PNG.
      const isPng = data.png.length > 8 && data.png[0] === 0x89 && data.png[1] === 0x50 && data.png[2] === 0x4e && data.png[3] === 0x47;
      const png = isPng ? data.png : new Uint8Array(nativeImage.createFromBuffer(Buffer.from(data.png)).toPNG());
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }) })]);
    } else if (data.html !== undefined) {
      await clipboard.write([new ClipboardItem({ 'text/plain': data.text, 'text/html': data.html })]);
    } else {
      await clipboard.writeText(data.text);
    }
  };

  const applyScreenshots = (s: Settings): void => {
    screenshotWatch?.close();
    screenshotWatch = null;
    screenshotDir = s.screenshotDir ?? defaultScreenshotDir();
    if (!s.monitoring || !s.screenshots || !s.captureImages) return;
    screenshotWatch = watchScreenshots({
      dir: screenshotDir,
      log: log.child('screenshots'),
      onImage: ({ data, mime }) => {
        const decoded = decodeImage(data);
        if (decoded) void core?.capture({ type: 'image', mime, data, pixels: decoded.pixels, thumb: decoded.thumb }, 'screenshot');
      },
    });
  };

  // The keyring changes when this device joins an account vault or a key rotation arrives.
  let vault = vaultState.status === 'ready' ? vaultState.vault : null;
  let account: AccountController | null = null;
  const library = vault
    ? new ClipLibrary({ db, keyring: () => vault!.keyring, deviceId: vault.deviceId, fetchBlob: (id) => account!.engine.fetchBlob(id) })
    : null;
  if (library && vault) {
    const env = import.meta.env;
    const sessions = sessionStore(safeStorage, join(userData, 'session.v1'));
    account = new AccountController({
      baseUrl: env.MAIN_VITE_API_URL || undefined,
      db,
      library,
      identity: { deviceId: vault.deviceId, keys: vault.deviceKeys },
      device: { name: hostname().slice(0, 64) || 'Ubuntu', platform: 'ubuntu', appVersion: app.getVersion() },
      getKeyring: () => vault!.keyring,
      setKeyring: async (ring) => {
        vault = { ...vault!, keyring: ring };
        await writeVault(safeStorage, vaultPath, vault);
      },
      loadSession: sessions.load,
      saveSession: sessions.save,
      googleIdToken: () => {
        if (!env.MAIN_VITE_GOOGLE_CLIENT_ID || !env.MAIN_VITE_GOOGLE_CLIENT_SECRET) throw new Error('Google sign-in is not configured in this build');
        return googleSignIn({ clientId: env.MAIN_VITE_GOOGLE_CLIENT_ID, clientSecret: env.MAIN_VITE_GOOGLE_CLIENT_SECRET, openBrowser: (u) => shell.openExternal(u) });
      },
      uploadBlob,
      downloadBlob,
      log: log.child('account'),
    });
  }
  const previewer = new LinkPreviewer(previewGet);
  const core: DesktopCore | null = library
    ? new DesktopCore({
        db,
        library,
        provider,
        writeClipboard,
        openExternal: (url) => shell.openExternal(url),
        chooseSavePath: async (defaultName) => {
          const r = await dialog.showSaveDialog({ title: 'Save', defaultPath: join(app.getPath('downloads'), defaultName) });
          return r.canceled || !r.filePath ? null : r.filePath;
        },
        applyScreenshots,
        decodeImage,
        linkPreview: (url) => previewer.preview(url),
        applyAutostart: (on) => setAutostart(on, launchCommand),
        activeApp: activeAppClasses,
        log: log.child('core'),
      })
    : null;

  const send = (channel: string): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel);
  };

  const status = async (): Promise<DesktopStatus> => ({
    vault: vaultState.status,
    ...(vaultState.status === 'error' ? { vaultError: vaultState.reason } : {}),
    keyringBackend: safeStorage.getSelectedStorageBackend(),
    provider: provider.name,
    session: isWaylandSession ? 'wayland' : process.env.XDG_SESSION_TYPE === 'x11' ? 'x11' : 'unknown',
    monitoring: core?.settings.monitoring ?? false,
    screenshotDir,
    screenshotWatching: screenshotWatch !== null,
    items: library?.list().length ?? 0,
    corrupt: library?.corruptCount ?? 0,
    gnomeShortcut: await gnomeShortcutInstalled(),
    globalShortcut: globalShortcutActive,
    deviceId: vaultState.status === 'ready' ? vaultState.vault.deviceId : null,
  });

  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
  registerIpc({
    ipcMain,
    allowedOrigin: devUrl ?? 'file://',
    core: () => core,
    library: () => library,
    status,
    installShortcut: () => installGnomeShortcut(`${launchCommand.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')} --toggle`, GNOME_BINDING),
    chooseBackupFile: async (mode) => {
      const filters = [{ name: 'Clipply backup', extensions: ['clipply'] }];
      if (mode === 'save') {
        const r = await dialog.showSaveDialog({ title: 'Export encrypted backup', defaultPath: `clipply-${new Date().toISOString().slice(0, 10)}.clipply`, filters });
        return r.canceled || !r.filePath ? null : r.filePath;
      }
      const r = await dialog.showOpenDialog({ title: 'Import backup', properties: ['openFile'], filters });
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    resetVault: async () => {
      if (vaultState.status === 'ready') throw new Error('vault is healthy; refusing to reset');
      db.close();
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
      rmSync(vaultPath, { force: true });
      relaunch();
      quitting = true;
      app.exit(0);
    },
    account: () => account,
    log: log.child('ipc'),
  });

  win = createMainWindow({
    preload: join(import.meta.dirname, '../preload/index.cjs'),
    devUrl,
    indexHtml: join(import.meta.dirname, '../renderer/index.html'),
    icon,
    shouldHideOnClose: () => !quitting && (core?.settings.closeToTray ?? false),
  });
  win.once('ready-to-show', () => {
    if (!startHidden) win?.show();
  });

  library?.subscribe(() => {
    send(CH.changed);
    account?.notifyLocalChange();
  });
  account?.onStatus(() => send(CH.accountChanged));

  if (core) {
    await core.start();
    await account?.init();
    account?.startScheduler();
    log.info('clipboard history ready', { items: library!.list().length, corrupt: library!.corruptCount });
  }

  const tray = createTray({
    icon,
    isMonitoring: () => core?.settings.monitoring ?? false,
    toggleWindow: () => win && toggleWindow(win),
    showWindow: () => win && showWindow(win),
    setMonitoring: (on) => void core?.updateSettings({ monitoring: on }),
    quit: () => {
      quitting = true;
      app.quit();
    },
  });
  core?.onStatusChange(() => {
    tray.refresh();
    send(CH.statusChanged);
  });

  // X11 key grab: works on X11 sessions; on GNOME Wayland the GNOME custom shortcut is used instead.
  try {
    if (globalShortcut.register(GLOBAL_SHORTCUT, () => win && toggleWindow(win))) globalShortcutActive = GLOBAL_SHORTCUT;
  } catch (error) {
    log.warn('global shortcut unavailable', { error });
  }

  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (argv.includes('--toggle')) toggleWindow(win);
    else showWindow(win);
  });
  app.on('window-all-closed', () => {
    // Background operation: the tray keeps the app alive.
  });
  app.on('before-quit', () => {
    quitting = true;
  });
  app.on('browser-window-focus', () => void account?.sync());
  app.on('will-quit', () => {
    if (provider instanceof HelperClipboardProvider) provider.dispose();
    account?.stopScheduler();
    globalShortcut.unregisterAll();
    screenshotWatch?.close();
    void core?.stop();
    tray.destroy();
    db.close();
  });
}

import { BrowserWindow } from 'electron';

export interface WindowOptions {
  preload: string;
  /** Dev server URL, or undefined to load the built file. */
  devUrl: string | undefined;
  indexHtml: string;
  icon: string;
  shouldHideOnClose: () => boolean;
}

/** Hardened window: no Node in the renderer, sandboxed preload, no navigation, no popups. */
export function createMainWindow(opts: WindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 560,
    minHeight: 420,
    show: false,
    backgroundColor: '#14161c',
    title: 'Clipply',
    icon: opts.icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.on('close', (e) => {
    if (opts.shouldHideOnClose()) {
      e.preventDefault();
      win.hide();
    }
  });
  if (opts.devUrl) void win.loadURL(opts.devUrl);
  else void win.loadFile(opts.indexHtml);
  return win;
}

export function toggleWindow(win: BrowserWindow): void {
  if (win.isVisible() && win.isFocused()) win.hide();
  else showWindow(win);
}

export function showWindow(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyring, initCrypto } from '@clipply/crypto';
import { migrate } from '@clipply/database';
import { openTestDb } from '@clipply/database/testing';
import { createLogger, type LogRecord } from '@clipply/logger';
import { ClipLibrary, uuidv7, type CaptureInput } from '@clipply/sync-engine';

import { autostartEntry, setAutostart } from './autostart';
import { fileChunkStore } from './chunkStore';
import { ElectronClipboardProvider, rawFormat, type ClipboardLike, type ClipboardProvider, type FileRef } from './clipboard/provider';
import { DesktopCore, type ClipboardWrite } from './core';
import { registerIpc, type IpcMainLike } from './ipc';
import { watchScreenshots } from './screenshot/watcher';
import { loadSettings, saveSettings, Settings } from './settings';
import { CLIPPLY_PATH, formatStringArray, installGnomeShortcut, parseStringArray } from './shortcuts/gnome';
import { openVault, type SecretStorage } from './vault';
import { kvRepo } from '@clipply/database';

const records: LogRecord[] = [];
const log = createLogger('test', { sink: (r) => records.push(r), level: 'debug' });
const DEVICE = '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
let tmp: string;

beforeAll(initCrypto);
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'clipply-test-'));
  records.length = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/** Fake async clipboard: one item whose types and payloads tests set. */
function fakeClipboard() {
  let data: Record<string, string | Uint8Array> = {};
  const clipboard: ClipboardLike = {
    read: vi.fn(async () =>
      Object.keys(data).length === 0
        ? []
        : [{ types: Object.keys(data), getType: async (t: string) => { const v = data[t]; return typeof v === 'string' ? v : new Blob([v as Uint8Array<ArrayBuffer>]); } }],
    ),
  };
  return { clipboard, set: (d: Record<string, string | Uint8Array>) => (data = d) };
}

function provider(cb: ReturnType<typeof fakeClipboard>, captureImages = true) {
  const p = new ElectronClipboardProvider({
    clipboard: cb.clipboard,
    decodeImage: (png) => ({ pixels: png, thumb: Uint8Array.of(1) }),
    captureImages: () => captureImages,
    log,
    intervalMs: 1_000_000,
  });
  const seen: CaptureInput[] = [];
  p.onClipboardChanged((i) => seen.push(i));
  return { p, seen };
}

describe('ElectronClipboardProvider', () => {
  it('baselines on start, then emits only real changes', async () => {
    const cb = fakeClipboard();
    cb.set({ 'text/plain': 'already there' });
    const { p, seen } = provider(cb);
    await p.start();
    await p.poll();
    expect(seen).toEqual([]);
    cb.set({ 'text/plain': 'new text' });
    await p.poll();
    await p.poll();
    expect(seen).toEqual([{ type: 'text', text: 'new text' }]);
    await p.stop();
  });

  it('captures every copied file by contents, and paths as text when none can be kept', async () => {
    const cb = fakeClipboard();
    const { p, seen } = provider(cb);
    const f = join(tmp, 'report.pdf');
    const g = join(tmp, 'my notes.txt');
    writeFileSync(f, Buffer.from('%PDF-1.7'));
    writeFileSync(g, 'hi');
    mkdirSync(join(tmp, 'folder'));
    const uri = (path: string): string => pathToFileURL(path).href;
    cb.set({ 'text/uri-list': `${uri(f)}\r\n`, 'text/plain': f });
    await p.poll();
    expect(seen).toEqual([{ type: 'file', mime: 'application/pdf', data: new Uint8Array(Buffer.from('%PDF-1.7')), name: 'report.pdf' }]);
    // A folder or a missing file among them is left out.
    cb.set({ 'text/uri-list': [f, g, join(tmp, 'folder'), join(tmp, 'gone')].map(uri).join('\n'), 'text/plain': 'paths' });
    await p.poll();
    await p.poll();
    expect(seen.slice(1).map((i) => i.type === 'file' && i.name)).toEqual(['report.pdf', 'my notes.txt']);
    cb.set({ 'text/uri-list': uri(join(tmp, 'folder')), 'text/plain': join(tmp, 'folder') });
    await p.poll();
    expect(seen[3]).toEqual({ type: 'text', text: join(tmp, 'folder') });
    cb.set({ 'text/uri-list': Array.from({ length: 21 }, () => uri(f)).join('\n'), 'text/plain': 'too many' });
    await p.poll();
    expect(seen[4]).toEqual({ type: 'text', text: 'too many' });
  });

  it('offers formatting next to the text when there is any, and stays with the text otherwise', async () => {
    const cb = fakeClipboard();
    const { p, seen } = provider(cb);
    cb.set({ 'text/plain': 'bold move', 'text/html': '<p><b>bold</b> move</p>' });
    await p.poll();
    cb.set({ 'text/plain': 'just text', 'text/html': '<span style="color:red">just text</span>' });
    await p.poll();
    cb.set({ 'text/plain': 'https://example.com/a', 'text/html': '<a href="https://example.com/a">https://example.com/a</a>' });
    await p.poll();
    cb.set({ 'text/plain': 'const x = 1;\nif (x) {\n  run();\n}', 'text/html': '<b>const</b> x = 1;' });
    await p.poll();
    cb.set({ 'text/plain': 'huge', 'text/html': `<b>${'x'.repeat(600_000)}</b>` });
    await p.poll();
    expect(seen.map((i) => i.type)).toEqual(['html', 'text', 'text', 'text', 'text']);
    expect(seen[0]).toEqual({ type: 'html', html: '<p><b>bold</b> move</p>', text: 'bold move' });
  });

  it('hands copied files over unread when asked to (the helper process)', async () => {
    const cb = fakeClipboard();
    const refs: FileRef[] = [];
    const p = new ElectronClipboardProvider({ clipboard: cb.clipboard, decodeImage: () => null, captureImages: () => true, onFileRef: (r) => refs.push(r), log, intervalMs: 1_000_000 });
    const f = join(tmp, 'a.txt');
    writeFileSync(f, 'x');
    cb.set({ 'text/uri-list': `file://${f}`, 'text/plain': f });
    await p.poll();
    expect(refs).toEqual([{ type: 'file-ref', path: f }]);
  });

  it('skips password-manager content and respects markCurrentAsSeen', async () => {
    const cb = fakeClipboard();
    const { p, seen } = provider(cb);
    await p.start();
    cb.set({ 'text/plain': 'hunter2', [rawFormat('x-kde-passwordManagerHint')]: 'secret' });
    await p.poll();
    cb.set({ 'text/plain': 'written by clipply' });
    await p.markCurrentAsSeen();
    await p.poll();
    expect(seen).toEqual([]);
    await p.stop();
  });

  it('prefers images, uses the X TIMESTAMP to avoid re-reading bytes, and honours captureImages', async () => {
    const cb = fakeClipboard();
    const { p, seen } = provider(cb);
    await p.start();
    cb.set({ 'image/png': Uint8Array.of(1, 2), 'text/plain': 'alt', [rawFormat('TIMESTAMP')]: Uint8Array.of(9) });
    await p.poll();
    expect(seen).toEqual([{ type: 'image', mime: 'image/png', data: Uint8Array.of(1, 2), pixels: Uint8Array.of(1, 2), thumb: Uint8Array.of(1) }]);
    cb.set({ 'image/png': Uint8Array.of(3, 4), [rawFormat('TIMESTAMP')]: Uint8Array.of(9) });
    await p.poll();
    expect(seen).toHaveLength(1);

    const cb2 = fakeClipboard();
    const noImg = provider(cb2, false);
    await noImg.p.start();
    cb2.set({ 'image/png': Uint8Array.of(1), 'text/plain': 'caption' });
    await noImg.p.poll();
    expect(noImg.seen).toEqual([{ type: 'text', text: 'caption' }]);
  });

  it('captures html-only content and survives read errors', async () => {
    const cb = fakeClipboard();
    const { p, seen } = provider(cb);
    await p.start();
    cb.set({ 'text/html': '<b>x</b>' });
    await p.poll();
    expect(seen).toEqual([{ type: 'html', html: '<b>x</b>' }]);
    vi.mocked(cb.clipboard.read).mockRejectedValueOnce(new Error('X error'));
    await p.poll();
    expect(records.some((r) => r.message === 'clipboard poll failed')).toBe(true);
  });
});

describe('screenshot watcher', () => {
  it('imports a new screenshot once, after its size settles', async () => {
    let listener: (e: string, f: string | null) => void = () => {};
    const got: string[] = [];
    const w = watchScreenshots({
      dir: tmp, log, settleMs: 10,
      watch: (_d, l) => ((listener = l), { close: () => {} }),
      onImage: (f) => got.push(`${f.path}:${f.data.length}:${f.mime}`),
    })!;
    writeFileSync(join(tmp, 'Screenshot.png'), Buffer.alloc(10));
    listener('rename', 'Screenshot.png');
    listener('change', 'Screenshot.png');
    listener('rename', 'notes.txt');
    listener('rename', '.hidden.png');
    await new Promise((r) => setTimeout(r, 120));
    listener('change', 'Screenshot.png');
    await new Promise((r) => setTimeout(r, 120));
    expect(got).toEqual([`${join(tmp, 'Screenshot.png')}:10:image/png`]);
    w.close();
  });

  it('is idle when neither the folder nor its parent exists', () => {
    expect(watchScreenshots({ dir: join(tmp, 'missing', 'Screenshots'), log, onImage: () => {} })).toBeNull();
  });

  it('starts watching when the folder is created by the first screenshot', async () => {
    const dir = join(tmp, 'Screenshots');
    const got: string[] = [];
    const w = watchScreenshots({ dir, log, settleMs: 10, onImage: (f) => got.push(f.path) })!;
    expect(w).not.toBeNull();
    mkdirSync(dir);
    writeFileSync(join(dir, 'first.png'), Buffer.alloc(5));
    await vi.waitFor(() => expect(got).toEqual([join(dir, 'first.png')]), { timeout: 2000 });
    writeFileSync(join(dir, 'second.png'), Buffer.alloc(5));
    await vi.waitFor(() => expect(got).toHaveLength(2), { timeout: 2000 });
    w.close();
  });
});

describe('GNOME shortcut', () => {
  it('parses and formats gsettings arrays', () => {
    expect(parseStringArray('@as []')).toEqual([]);
    expect(parseStringArray("['/a/', '/b/']\n")).toEqual(['/a/', '/b/']);
    expect(parseStringArray(formatStringArray(["it's", 'x']))).toEqual(["it's", 'x']);
    expect(() => parseStringArray('garbage')).toThrow();
  });

  it('appends Clipply to existing bindings without dropping them', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] !== 'get') return '';
      return args[1] === 'org.gnome.shell.keybindings' ? "['<Super>v', '<Super>m']" : "['/other/']";
    };
    await installGnomeShortcut("'/usr/bin/clipply' --toggle", '<Super>v', run);
    // Super+V is taken from GNOME's notification list; Super+M keeps it.
    expect(calls).toContainEqual(['set', 'org.gnome.shell.keybindings', 'toggle-message-tray', "['<Super>m']"]);
    expect(calls).toContainEqual(['set', 'org.gnome.settings-daemon.plugins.media-keys', 'custom-keybindings', `['/other/', '${CLIPPLY_PATH}']`]);
    const key = `org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:${CLIPPLY_PATH}`;
    // Values are GVariant string literals; a raw command starting with a quote is rejected by gsettings.
    expect(calls).toContainEqual(['set', key, 'command', "'\\'/usr/bin/clipply\\' --toggle'"]);
    expect(calls.at(-1)).toEqual(['set', key, 'binding', "'<Super>v'"]);
  });
});

describe('GNOME shortcut status', () => {
  it('counts only a complete install with the current binding', async () => {
    const { gnomeShortcutInstalled } = await import('./shortcuts/gnome');
    const state = (command: string, binding: string) => async (args: string[]): Promise<string> =>
      args[1]!.endsWith('media-keys') ? `['${CLIPPLY_PATH}']` : args[2] === 'command' ? command : binding;
    expect(await gnomeShortcutInstalled(state("''", "''"))).toBe(false); // left by a failed install
    expect(await gnomeShortcutInstalled(state("'/usr/bin/clipply --toggle'", "'<Super><Shift>v'"))).toBe(false); // old binding
    // gsettings prints a command containing single quotes inside double quotes.
    expect(await gnomeShortcutInstalled(state(`"'apps/dist/Clipply.AppImage' --toggle"`, "'<Super>v'"))).toBe(false); // relative path
    expect(await gnomeShortcutInstalled(state(`"'/opt/Clipply.AppImage' --toggle"`, "'<Super>v'"))).toBe(true);
    expect(await gnomeShortcutInstalled(state("'/usr/bin/clipply --toggle'", "'<Super>v'"))).toBe(true);
  });
});

describe('autostart', () => {
  it('writes and removes an XDG autostart entry with quoted paths', () => {
    expect(autostartEntry(['/opt/My Apps/clipply'])).toContain('Exec="/opt/My Apps/clipply" --hidden');
    setAutostart(true, ['/usr/bin/clipply'], tmp);
    const path = join(tmp, '.config/autostart/clipply.desktop');
    expect(readFileSync(path, 'utf8')).toContain('Exec=/usr/bin/clipply --hidden');
    setAutostart(false, [], tmp);
    expect(existsSync(path)).toBe(false);
  });
});

describe('settings', () => {
  it('falls back per field and rejects unknown patches', async () => {
    const db = openTestDb();
    await migrate(db);
    const kv = kvRepo(db);
    await kv.set('settings', { retentionDays: -5, captureImages: false, bogus: 1 });
    const s = await loadSettings(kv);
    expect(s).toMatchObject({ retentionDays: 30, captureImages: false });
    await expect(saveSettings(kv, s, { nope: true } as never)).rejects.toThrow();
    expect((await saveSettings(kv, s, { retentionDays: 0 })).retentionDays).toBe(0);
    expect(Settings.parse({})).toMatchObject({ monitoring: true, closeToTray: true });
  });
});

describe('vault', () => {
  const storage = (backend = 'gnome_libsecret', shouldReEncrypt = false): SecretStorage => ({
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (s) => Buffer.from(s, 'utf8').reverse(),
    decryptStringAsync: async (b) => ({ result: Buffer.from(b).reverse().toString('utf8'), shouldReEncrypt }),
  });

  it('creates once, reopens the same keys, and writes a 0600 file', async () => {
    const path = join(tmp, 'vault.v1');
    const first = await openVault(storage(), path, false, () => DEVICE);
    expect(first.status).toBe('ready');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = await openVault(storage(), path, true, () => 'unused');
    expect((await openVault(storage('gnome_libsecret', true), path, true, () => 'x')).status).toBe('ready');
    if (first.status !== 'ready' || again.status !== 'ready') throw new Error('expected ready');
    expect(again.created).toBe(false);
    expect(again.vault.deviceId).toBe(DEVICE);
    expect(again.vault.keyring.keys.get(1)).toEqual(first.vault.keyring.keys.get(1));
    expect(readFileSync(path).toString('latin1')).not.toContain(DEVICE);
  });

  it('refuses plaintext key storage and never replaces a lost vault', async () => {
    expect(await openVault(storage('basic_text'), join(tmp, 'v'), false, () => DEVICE)).toEqual({ status: 'no_keyring', backend: 'basic_text' });
    expect(await openVault(storage(), join(tmp, 'v'), true, () => DEVICE)).toEqual({ status: 'error', reason: 'missing' });
    writeFileSync(join(tmp, 'bad'), 'garbage');
    expect(await openVault(storage(), join(tmp, 'bad'), true, () => DEVICE)).toEqual({ status: 'error', reason: 'unreadable' });
  });
});

describe('DesktopCore + IPC', () => {
  async function setup(activeApp?: () => Promise<string[] | null>) {
    const db = openTestDb();
    await migrate(db);
    const ring = createKeyring();
    const library = new ClipLibrary({ db, keyring: () => ring, deviceId: DEVICE });
    let onChange: (i: CaptureInput) => void = () => {};
    const prov: ClipboardProvider = {
      name: 'fake', start: vi.fn(async () => {}), stop: vi.fn(async () => {}), readCurrentClipboard: async () => null,
      markCurrentAsSeen: vi.fn(async () => {}), onClipboardChanged: (cb) => (onChange = cb),
    };
    const writes: ClipboardWrite[] = [];
    const opened: string[] = [];
    const core = new DesktopCore({
      db, library, provider: prov, log,
      writeClipboard: async (w) => void writes.push(w),
      openExternal: async (u) => void opened.push(u),
      applyScreenshots: vi.fn(), applyAutostart: vi.fn(), ...(activeApp ? { activeApp } : {}),
      decodeImage: (data) => (data[0] === 0x89 ? { pixels: data, thumb: Uint8Array.of(7) } : null),
    });
    await core.start();
    return { core, library, prov, writes, opened, emit: (i: CaptureInput) => onChange(i) };
  }

  it('keeps formatting only when the setting is on, and copies both versions back', async () => {
    const { core, library, writes, emit } = await setup();
    const copy: CaptureInput = { type: 'html', html: '<p><b>bold</b> move</p><p>next</p>', text: 'bold move\n\nnext' };
    emit(copy);
    await vi.waitFor(() => expect(library.list().map((v) => v.meta.kind)).toEqual(['text']));
    expect(library.list()[0]!.preview).toBe('bold move\n\nnext');
    await core.updateSettings({ keepFormatting: true });
    emit(copy);
    await vi.waitFor(() => expect(library.list({ kinds: ['html'] })).toHaveLength(1));
    const [rich] = library.list({ kinds: ['html'] });
    expect(rich!.preview).toBe('bold move\n\nnext');
    await core.copy(rich!.id);
    expect(writes).toEqual([{ text: 'bold move\n\nnext', html: copy.html }]);
    // HTML that came without a plain version is kept either way.
    await core.updateSettings({ keepFormatting: false });
    emit({ type: 'html', html: '<i>only html</i>' });
    await vi.waitFor(() => expect(library.list({ kinds: ['html'] })).toHaveLength(2));
  });

  it('skips copies made in an excluded app', async () => {
    let focused: string[] | null = ['keepassxc'];
    const { core, library } = await setup(async () => focused);
    await core.updateSettings({ excludedApps: [' KeePassXC '] });
    expect(core.settings.excludedApps).toEqual(['keepassxc']);
    await core.capture({ type: 'text', text: 'from the vault app' }, 'clipboard');
    focused = null; // unknown (native Wayland window): captured
    await core.capture({ type: 'text', text: 'unknown source' }, 'clipboard');
    focused = ['gnome-terminal-server', 'gnome-terminal'];
    await core.capture({ type: 'text', text: 'from terminal' }, 'clipboard');
    expect(library.list().map((v) => v.preview).sort()).toEqual(['from terminal', 'unknown source']);
  });

  it('parses xprop output', async () => {
    const { parseActiveWindow, parseWmClass } = await import('./clipboard/activeApp');
    expect(parseActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x3a00007')).toBe('0x3a00007');
    expect(parseActiveWindow('_NET_ACTIVE_WINDOW(WINDOW): window id # 0x0')).toBeNull();
    expect(parseWmClass('WM_CLASS(STRING) = "keepassxc", "KeePassXC"')).toEqual(['keepassxc']);
    expect(parseWmClass('WM_CLASS:  not found.')).toEqual([]);
  });

  it('captures from the provider, copies back without re-capture, and never logs content', async () => {
    const { core, library, prov, writes, emit } = await setup();
    emit({ type: 'text', text: 'TOP SECRET' });
    await vi.waitFor(() => expect(library.list()).toHaveLength(1));
    const id = library.list()[0]!.id;
    await core.copy(id);
    expect(writes).toEqual([{ text: 'TOP SECRET' }]);
    expect(prov.markCurrentAsSeen).toHaveBeenCalled();
    expect(JSON.stringify(records)).not.toContain('TOP SECRET');
  });

  it('pauses capture, opens only http(s) links and clears unpinned history', async () => {
    const { core, library, prov, opened, emit } = await setup();
    await library.capture({ type: 'text', text: 'https://example.com/x' });
    await library.capture({ type: 'text', text: 'keep me' });
    const keep = library.list().find((v) => v.preview === 'keep me')!;
    await library.setFlags(keep.id, { pinned: true });
    await core.openUrl(library.list().find((v) => v.meta.kind === 'url')!.id);
    expect(opened).toEqual(['https://example.com/x']);
    await expect(core.openUrl(keep.id)).rejects.toThrow(/not a link/);
    await core.capture({ type: 'file', mime: 'application/pdf', data: Uint8Array.of(1), name: 'a.pdf' }, 'clipboard');
    const file = library.list({ kinds: ['file'] })[0]!;
    await expect(core.copy(file.id)).rejects.toThrow(/use Save/);
    await library.remove([file.id]);

    await core.updateSettings({ monitoring: false });
    expect(prov.stop).toHaveBeenCalled();
    emit({ type: 'text', text: 'while paused' });
    await new Promise((r) => setTimeout(r, 20));
    expect(library.list().some((v) => v.preview === 'while paused')).toBe(false);

    expect(library.stats()).toMatchObject({ count: 2, kept: 1 });
    expect(await library.clear()).toBe(1);
    expect(library.list().map((v) => v.preview)).toEqual(['keep me']);
  });

  it('adds text, images and files by hand, even while paused, via IPC', async () => {
    const { core, library } = await setup();
    await core.updateSettings({ monitoring: false, captureImages: false });
    const handlers = new Map<string, (e: { senderFrame: { url: string } | null }, ...a: unknown[]) => unknown>();
    registerIpc({
      ipcMain: { handle: (c, l) => void handlers.set(c, l) }, allowedOrigin: 'file://', core: () => core, library: () => library, log,
      status: async () => ({}) as never, installShortcut: async () => {}, hideWindow: () => {}, resetVault: async () => {}, account: () => null, chooseBackupFile: async () => null, updates: {} as never, openReleasePage: async () => {}, installUpdate: async () => {},
    });
    const add = (input: unknown) => handlers.get('clips:add')!({ senderFrame: { url: 'file:///app' } }, input);
    expect(await add({ type: 'text', text: 'typed note' })).toEqual({ duplicate: false });
    expect(await add({ type: 'text', text: 'typed note' })).toEqual({ duplicate: true });
    await add({ type: 'image', name: 'a.png', mime: 'image/png', data: Uint8Array.of(0x89, 1, 2) });
    // Undecodable "image" is kept as a file so it can still be saved.
    await add({ type: 'image', name: 'b.heic', mime: 'image/heic', data: Uint8Array.of(1, 2) });
    await add({ type: 'file', name: 'c.pdf', mime: 'application/pdf', data: Uint8Array.of(3) });
    const byKind = library.list().map((v) => [v.meta.kind, v.meta.file?.name ?? v.preview, v.hasThumb]);
    expect(byKind).toEqual(expect.arrayContaining([['text', 'typed note', false], ['image', '', true], ['file', 'b.heic', false], ['file', 'c.pdf', false]]));
    await expect(add({ type: 'file', name: 'x', mime: 'a/b', data: new Uint8Array(0) })).rejects.toThrow(/invalid arguments/);
    await expect(add({ type: 'text', text: '   ' })).rejects.toThrow(/empty/);
  });

  it('IPC rejects untrusted frames and invalid arguments', async () => {
    const { core, library } = await setup();
    const handlers = new Map<string, (e: { senderFrame: { url: string } | null }, ...a: unknown[]) => unknown>();
    const ipcMain: IpcMainLike = { handle: (c, l) => void handlers.set(c, l) };
    registerIpc({
      ipcMain, allowedOrigin: 'file://', core: () => core, library: () => library, log,
      status: async () => ({}) as never, installShortcut: async () => {}, hideWindow: () => {}, resetVault: async () => {}, account: () => null, chooseBackupFile: async () => null, updates: {} as never, openReleasePage: async () => {}, installUpdate: async () => {},
    });
    const list = handlers.get('clips:list')!;
    await expect(list({ senderFrame: { url: 'https://evil.test' } }, {})).rejects.toThrow('untrusted sender');
    await expect(list({ senderFrame: null }, {})).rejects.toThrow('untrusted sender');
    await expect(list({ senderFrame: { url: 'file:///app/index.html' } }, { evil: 1 })).rejects.toThrow(/invalid arguments/);
    await expect(handlers.get('clips:body')!({ senderFrame: { url: 'file:///x' } }, 'not-a-uuid')).rejects.toThrow(/invalid arguments/);
    expect(await list({ senderFrame: { url: 'file:///app/index.html' } }, {})).toEqual({ items: [], total: 0 });
    await expect(handlers.get('clips:body')!({ senderFrame: { url: 'file:///x' } }, uuidv7())).rejects.toThrow(/ItemNotFoundError/);
  });
});

describe('file chunk store', () => {
  it('keeps chunks private to the user, and refuses anything that is not an item id', async () => {
    const dir = join(tmp, 'chunks');
    const store = fileChunkStore(dir);
    expect(await store.ids()).toEqual([]);
    expect(await store.get(DEVICE, 0)).toBeNull();
    await store.put(DEVICE, 0, Uint8Array.of(1, 2));
    expect(await store.get(DEVICE, 0)).toEqual(Uint8Array.of(1, 2));
    expect([await store.has(DEVICE, 0), await store.has(DEVICE, 1)]).toEqual([true, false]);
    expect(statSync(join(dir, DEVICE, '0')).mode & 0o777).toBe(0o600);
    expect(await store.ids()).toEqual([DEVICE]);
    await expect(store.put('../../etc', 0, Uint8Array.of(1))).rejects.toThrow(/item id/);
    await store.remove(DEVICE);
    expect(await store.ids()).toEqual([]);
  });

  it('saves a file kept in chunks to disk, byte for byte', async () => {
    const db = openTestDb();
    await migrate(db);
    const ring = createKeyring();
    const library = new ClipLibrary({ db, keyring: () => ring, deviceId: DEVICE, chunks: fileChunkStore(join(tmp, 'chunks')) });
    const out = join(tmp, 'out.bin');
    const core = new DesktopCore({
      db, library, log, writeClipboard: async () => {}, openExternal: async () => {}, applyScreenshots: () => {}, applyAutostart: () => {},
      chooseSavePath: async () => out,
      provider: { name: 'fake', start: async () => {}, stop: async () => {}, readCurrentClipboard: async () => null, markCurrentAsSeen: async () => {}, onClipboardChanged: () => {} },
    });
    const data = Uint8Array.from({ length: 12_000_000 }, (_, i) => (i * 17 + (i >> 10)) & 255);
    const { id } = (await library.capture({ type: 'file', mime: 'x/y', name: 'a.bin', data }))!;
    expect(await core.saveFile(id)).toBe(true);
    expect(Buffer.compare(readFileSync(out), data)).toBe(0);
  });
});

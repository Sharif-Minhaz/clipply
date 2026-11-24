import { App as CapApp } from '@capacitor/app';
import { CapacitorHttp } from '@capacitor/core';
import { SocialLogin } from '@capgo/capacitor-social-login';
import { z } from 'zod';
import {
  concat, createKeyring, fromB64, fromUtf8, generateDeviceKeys, initCrypto, parseKeyring, serializeKeyring, toB64,
  type DeviceKeyPairs, type Keyring,
} from '@clipply/crypto';
import { kvRepo, migrate, type SqlDb } from '@clipply/database';
import { createLogger } from '@clipply/logger';
import { DEFAULT_OCR_LANGUAGES, OcrLanguages } from '@clipply/shared-schemas';
import { AccountController, ClipLibrary, exportBackup, htmlToText, importBackup, LinkPreviewer, MAX_CAPTURE_BYTES, RELEASES_LATEST, saveFileName, UpdateChecker, uuidv7, type PreviewGet, type StoredSession } from '@clipply/sync-engine';
import type { AccountClient, BackupActions, ClipplyClient, UpdateClient } from '@clipply/ui';

import { b64ToBytes, bytesToB64, chunkStore, ClipplyNative, type InboxEntry } from './native';
import { decodeImage } from './images';
import { recognizeWith, tesseract } from './ocr';
import { openCapacitorDb } from './sqlite';

const log = createLogger('mobile');

/** Same shape as the desktop vault file, so the Kotlin upload worker reads it too. */
const VaultJson = z.object({
  v: z.literal(1), deviceId: z.uuid(), keyring: z.string(),
  box: z.object({ pk: z.string(), sk: z.string() }), sign: z.object({ pk: z.string(), sk: z.string() }),
});
interface Vault {
  deviceId: string;
  keyring: Keyring;
  keys: DeviceKeyPairs;
}

const secure = {
  get: async (key: string): Promise<string | null> => (await ClipplyNative.secureGet({ key })).value,
  set: (key: string, value: string): Promise<void> => ClipplyNative.secureSet({ key, value }),
  remove: (key: string): Promise<void> => ClipplyNative.secureRemove({ key }),
};

async function saveVault(v: Vault): Promise<void> {
  await secure.set('vault', JSON.stringify({
    v: 1, deviceId: v.deviceId, keyring: toB64(serializeKeyring(v.keyring)),
    box: { pk: toB64(v.keys.box.publicKey), sk: toB64(v.keys.box.privateKey) },
    sign: { pk: toB64(v.keys.sign.publicKey), sk: toB64(v.keys.sign.privateKey) },
  }));
}

/** Never silently replaces a lost vault while encrypted history exists (same rule as desktop). */
async function loadVault(db: SqlDb): Promise<Vault> {
  const raw = await secure.get('vault');
  if (raw) {
    const f = VaultJson.parse(JSON.parse(raw));
    return {
      deviceId: f.deviceId, keyring: parseKeyring(fromB64(f.keyring)),
      keys: { box: { publicKey: fromB64(f.box.pk), privateKey: fromB64(f.box.sk) }, sign: { publicKey: fromB64(f.sign.pk), privateKey: fromB64(f.sign.sk) } },
    };
  }
  const [row] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM items');
  if ((row?.n ?? 0) > 0) throw new Error('The encryption key for this history is missing (app data was partially cleared).');
  const v: Vault = { deviceId: uuidv7(), keyring: createKeyring(), keys: generateDeviceKeys() };
  await saveVault(v);
  return v;
}

export const MobileSettings = z.object({
  monitoring: z.boolean().default(true),
  captureOnOpen: z.boolean().default(true),
  screenshots: z.boolean().default(false),
  retentionDays: z.number().int().min(0).max(3650).default(30),
  /** Fetch Open Graph images for links (the site sees this device's IP). */
  linkPreviews: z.boolean().default(true),
  /** Ask GitHub for a newer release on every cold start, then at most once a day on resume. */
  checkUpdates: z.boolean().default(true),
  /** Languages text recognition reads besides English. */
  ocrLanguages: OcrLanguages.default([...DEFAULT_OCR_LANGUAGES]),
});

/** Native GET (the WebView's fetch is blocked by CORS); redirects are left to the shared code to check hop by hop. */
const previewGet: PreviewGet = async (url, maxBytes) => {
  const res = await CapacitorHttp.get({
    url,
    responseType: 'arraybuffer',
    disableRedirects: true,
    connectTimeout: 8_000,
    readTimeout: 8_000,
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; ClipplyLinkPreview/1.0)', accept: 'text/html,application/xhtml+xml,image/*;q=0.8' },
  });
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
  // Binary responses arrive base64-encoded; anything else (an error page parsed as JSON) is not a preview.
  const body = typeof res.data === 'string' && res.status >= 200 && res.status < 300 ? b64ToBytes(res.data) : new Uint8Array(0);
  return { status: res.status, headers, body: body.subarray(0, maxBytes + 1) };
};
export type MobileSettings = z.infer<typeof MobileSettings>;

export interface Runtime extends BackupActions {
  client: ClipplyClient;
  account: AccountClient;
  updates: UpdateClient;
  deviceId: string;
  settings(): MobileSettings;
  updateSettings(patch: Partial<MobileSettings>): Promise<MobileSettings>;
  captureNow(): Promise<string>;
}

export async function boot(): Promise<Runtime> {
  await initCrypto();
  const db = await openCapacitorDb();
  await migrate(db);
  let vault = await loadVault(db);
  const kv = kvRepo(db);
  let settings = MobileSettings.parse((await kv.get('settings.mobile')) ?? {});
  // The installed versionName (set from package.json by the release script).
  const appVersion = await CapApp.getInfo().then((i) => i.version, () => '0.0.0');

  let controller: AccountController | null = null;
  const library = new ClipLibrary({
    db, keyring: () => vault.keyring, deviceId: vault.deviceId, fetchBlob: (id, chunk) => controller!.engine.fetchBlob(id, chunk), chunks: chunkStore,
    recognizeText: (image, mime) => recognizeWith(
      async () => (await ClipplyNative.recognizeText({ data: bytesToB64(image) })).text,
      () => tesseract(image, mime, settings.ocrLanguages),
    ),
  });
  await library.load();

  const apiUrl = import.meta.env.VITE_API_URL as string | undefined;
  // The background upload worker reads these from the same Keystore-backed store.
  if (apiUrl) await secure.set('config', JSON.stringify({ apiUrl }));
  controller = new AccountController({
    baseUrl: apiUrl || undefined,
    db,
    library,
    identity: { deviceId: vault.deviceId, keys: vault.keys },
    newIdentity: async () => {
      // Saved before use so the background upload worker signs in under the same new id.
      vault = { ...vault, deviceId: uuidv7(), keys: generateDeviceKeys() };
      await saveVault(vault);
      return { deviceId: vault.deviceId, keys: vault.keys };
    },
    device: { name: (await ClipplyNative.deviceName()).name.slice(0, 64) || 'Android', platform: 'android', appVersion },
    getKeyring: () => vault.keyring,
    setKeyring: async (ring) => {
      vault = { ...vault, keyring: ring };
      await saveVault(vault);
    },
    loadSession: async () => {
      const raw = await secure.get('session');
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    },
    saveSession: async (s) => (s ? secure.set('session', JSON.stringify(s)) : secure.remove('session')),
    googleIdToken: async () => {
      const webClientId = import.meta.env.VITE_GOOGLE_WEB_CLIENT_ID as string | undefined;
      if (!webClientId) throw new Error('Google sign-in is not configured in this build');
      // Only the ID token is needed (the server verifies it); no Google API access, so skip the scope authorization step.
      await SocialLogin.initialize({ google: { webClientId, mode: 'online', skipAuthOnlyAuthorizationAfterSignIn: true } });
      const { result } = await SocialLogin.login({ provider: 'google', options: {} });
      if (result.responseType !== 'online' || !result.idToken) throw new Error('Google did not return an account');
      return result.idToken;
    },
    uploadBlob: async (url, fields, ciphertext) => {
      const { json } = await ClipplyNative.uploadBlob({ url, fields, data: bytesToB64(ciphertext) });
      return JSON.parse(json) as { public_id: string; version: number; signature: string; bytes: number };
    },
    downloadBlob: async (url) => b64ToBytes((await ClipplyNative.downloadBlob({ url })).data),
    log: log.child('account'),
  });
  const account = controller;
  // Network work (device list, vault state, key refresh) must not hold up the first screen: history
  // is local. Status updates reach the UI when it finishes; init starts the first sync itself.
  const accountReady = account.init().catch((error: unknown) => log.warn('account init failed', { error }));

  let lastSelfWrite: string | null = null;
  /** `createdAt` set (inbox entries): keep the original time, so a screenshot taken while Clipply was closed sorts where it happened. */
  const capture = async (entry: Pick<InboxEntry, 'type' | 'mime' | 'data' | 'name'> & { text?: string; createdAt?: number; bytes?: Uint8Array }): Promise<void> => {
    if (!settings.monitoring) return;
    const restore = entry.createdAt ? { createdAt: entry.createdAt, pinned: false, favorite: false } : undefined;
    if (entry.type === 'text') {
      const text = entry.text ?? fromUtf8(b64ToBytes(entry.data ?? ''));
      if (text === lastSelfWrite) return;
      await library.capture({ type: 'text', text }, restore);
      return;
    }
    const data = entry.bytes ?? b64ToBytes(entry.data ?? '');
    if (entry.type === 'file') {
      await library.capture({ type: 'file', mime: entry.mime, data, name: entry.name ?? 'file' }, restore);
      return;
    }
    // An image the WebView cannot decode (e.g. HEIC) is still kept, just without a thumbnail.
    const decoded = await decodeImage(data, entry.mime).catch(() => null);
    if (!decoded) log.warn('image kept without thumbnail', { mime: entry.mime });
    await library.capture({ type: 'image', mime: entry.mime, data, ...(decoded ? { thumb: decoded.thumb, pixels: decoded.pixels } : {}) }, restore);
  };

  /** A large shared file; parts cross the bridge one at a time. */
  const readParts = async (id: string, count: number): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const { data } = await ClipplyNative.inboxPart({ id, index });
      if (data === null) throw new Error(`part ${index} is missing`);
      parts.push(b64ToBytes(data));
    }
    return concat(...parts);
  };

  const drainInbox = async (): Promise<void> => {
    const { entries } = await ClipplyNative.drainInbox();
    for (const e of entries) {
      try {
        await capture(e.parts ? { ...e, bytes: await readParts(e.id, e.parts) } : e);
      } catch (error) {
        log.warn('inbox item skipped', { error, source: e.source });
      } finally {
        if (e.parts) await ClipplyNative.inboxDone({ id: e.id });
      }
    }
  };

  /**
   * `auto` (window focus): skip a clipboard that has not changed since the last read. Re-saving it would
   * count as a fresh copy and move old text above newer clips (a screenshot taken meanwhile).
   */
  const readClipboard = async (auto = false): Promise<string> => {
    const clip = await ClipplyNative.readClipboard();
    if (clip.type === 'sensitive') return 'Skipped: the clipboard holds sensitive content.';
    if (clip.type === 'none') return 'The clipboard is empty.';
    const ts = clip.timestamp ?? 0;
    if (auto && ts > 0 && ts <= ((await kv.get<number>('clipboard.lastTimestamp')) ?? 0)) return 'Already saved.';
    if (ts > 0) await kv.set('clipboard.lastTimestamp', ts);
    // Saved on open: date it when it was copied (Android records that), not when Clipply opened.
    const when = auto && ts > 0 ? { createdAt: ts } : {};
    if (clip.type === 'text' && clip.text) await capture({ type: 'text', mime: 'text/plain', data: '', text: clip.text, ...when });
    if (clip.type === 'image' && clip.data && clip.mime) {
      await capture({ type: 'image', mime: clip.mime, data: clip.data, ...when });
      return 'Image saved.';
    }
    return 'Saved.';
  };

  // Foreground capture: the OS allows reading the clipboard only while our window has focus.
  const captureOnFocus = (): void => {
    if (settings.captureOnOpen && settings.monitoring) void readClipboard(true).catch((error: unknown) => log.warn('clipboard read failed', { error }));
  };
  await ClipplyNative.addListener('windowFocus', captureOnFocus);
  // On a cold start the window gained focus before this listener existed, so read once now.
  captureOnFocus();
  await ClipplyNative.addListener('inbox', () => void drainInbox());
  // Check-only: one anonymous GET to GitHub (native HTTP, like link previews), on every cold start, then at most daily on resume.
  const updateListeners = new Set<() => void>();
  const updateChecker = new UpdateChecker({
    currentVersion: appVersion,
    fetchLatest: async () => {
      const res = await CapacitorHttp.get({
        url: RELEASES_LATEST,
        disableRedirects: true,
        connectTimeout: 10_000,
        readTimeout: 10_000,
        headers: { 'user-agent': 'Clipply' },
      });
      if (res.status < 300 || res.status >= 400) throw new Error(`GitHub answered ${res.status}`);
      const location = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'location')?.[1];
      return location === undefined ? null : String(location);
    },
    store: { get: () => kv.get('update.check'), set: (v) => kv.set('update.check', v) },
  });
  const autoCheckUpdates = (force = false): void => {
    if (!settings.checkUpdates) return;
    updateChecker.check({ force }).then(
      () => updateListeners.forEach((l) => l()),
      (error: unknown) => log.debug('update check failed', { error }),
    );
  };
  const updates: UpdateClient = {
    state: () => updateChecker.state(),
    check: () => updateChecker.check({ force: true }),
    openReleasePage: async () => void window.open((await updateChecker.state()).url, '_system'),
    install: async (onProgress) => {
      const { available, latest } = await updateChecker.state();
      if (!available || !latest) throw new Error('Clipply is up to date');
      const progress = await ClipplyNative.addListener('updateProgress', (e) => onProgress?.(e.percent));
      try {
        await ClipplyNative.installUpdate({ version: latest });
      } finally {
        await progress.remove();
      }
    },
    onChange: (cb) => {
      updateListeners.add(cb);
      return () => updateListeners.delete(cb);
    },
  };
  autoCheckUpdates(true);

  await CapApp.addListener('resume', () => {
    void drainInbox().then(() => account.sync());
    account.startScheduler();
    autoCheckUpdates();
  });
  // Check for other devices' clips every minute only while Clipply is on screen; nothing runs in the background.
  await CapApp.addListener('pause', () => account.stopScheduler());
  account.startScheduler();
  library.subscribe(() => account.notifyLocalChange());
  // Importing waiting captures (decoding screenshots) and cleanup must not delay the first screen.
  void drainInbox()
    .then(() => (settings.retentionDays > 0 ? library.applyRetention(settings.retentionDays * 86_400_000) : 0))
    .catch((error: unknown) => log.warn('startup import failed', { error }));
  void accountReady.then(() => account.sync());

  const previewer = new LinkPreviewer(previewGet);
  const client: ClipplyClient = {
    list: async (f) => library.page(f),
    subscribe: (cb) => library.subscribe(cb),
    readThumb: (id) => library.readThumb(id),
    readBody: (id) => library.readBody(id),
    linkPreview: async (id) => {
      if (!settings.linkPreviews || library.get(id)?.meta.kind !== 'url') return null;
      return previewer.preview(fromUtf8(await library.readBody(id)).trim());
    },
    openUrl: async (id) => {
      const url = new URL(fromUtf8(await library.readBody(id)).trim());
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) links can be opened');
      window.open(url.toString(), '_system');
    },
    copy: async (id) => {
      const v = library.get(id);
      if (v?.meta.kind === 'file') throw new Error('files cannot be put on the clipboard; use Save instead');
      const body = await library.readBody(id);
      if (v?.meta.kind === 'image') await ClipplyNative.writeClipboardImage({ data: bytesToB64(body), mime: v.meta.mime });
      else {
        const content = fromUtf8(body);
        const html = v?.meta.kind === 'html' ? content : undefined;
        lastSelfWrite = html === undefined ? content : htmlToText(html);
        await ClipplyNative.writeClipboardText({ text: lastSelfWrite, ...(html === undefined ? {} : { html }) });
      }
    },
    copyText: async (text) => {
      lastSelfWrite = text;
      await ClipplyNative.writeClipboardText({ text });
    },
    recognizeText: (id) => library.recognize(id),
    imageText: (id) => library.readOcr(id),
    similarTexts: () => library.similarTexts(),
    saveFile: async (id) => {
      const v = library.get(id);
      if (!v) throw new Error('item not found');
      const name = saveFileName(v.meta);
      if (v.meta.size > MAX_CAPTURE_BYTES) {
        // Everything is on the device before the user is asked where to put it.
        await library.cacheBody(id);
        const { handle } = await ClipplyNative.createDocument({ name });
        if (handle === null) return false;
        try {
          for await (const part of library.bodyParts(id)) await ClipplyNative.appendDocument({ handle, data: bytesToB64(part) });
        } finally {
          await ClipplyNative.closeDocument({ handle });
        }
        return true;
      }
      return (await ClipplyNative.saveDocument({ name, data: bytesToB64(await library.readBody(id)) })).saved;
    },
    setFlags: (id, flags) => library.setFlags(id, flags),
    editText: (id, text) => library.editText(id, text),
    // An explicit action: not subject to the monitoring pause. An image the WebView cannot decode is kept as a file.
    add: async (input) => {
      let res;
      if (input.type === 'text') res = await library.capture({ type: 'text', text: input.text });
      else {
        const decoded = input.type === 'image' ? await decodeImage(input.data, input.mime, false) : null;
        res = await library.capture(
          decoded
            ? { type: 'image', mime: input.mime, data: input.data, thumb: decoded.thumb }
            : { type: 'file', mime: input.mime, data: input.data, name: input.name },
        );
      }
      if (!res) throw new Error('nothing to add: the text is empty');
      return { duplicate: res.duplicate };
    },
    remove: (ids) => library.remove(ids),
    storage: async () => library.stats(),
    clear: (kinds) => library.clear(kinds),
  };

  const accountClient: AccountClient = {
    status: async () => account.getStatus(),
    onStatus: (cb) => account.onStatus(cb),
    signIn: () => account.signIn(),
    signOut: async () => {
      await account.signOut();
      // Forget the Google account Credential Manager remembered, so the next sign-in shows the picker.
      await SocialLogin.logout({ provider: 'google' }).catch((error: unknown) => log.debug('google logout failed', { error }));
    },
    syncNow: () => account.sync(),
    enrollment: () => account.enrollment(),
    acceptEnrollment: () => account.acceptEnrollment(),
    recover: (k) => account.recover(k),
    devices: () => account.devices(),
    deviceNames: () => account.deviceNames(),
    startApproval: (id) => account.startApproval(id),
    approvalCode: (id) => account.approvalCode(id),
    pairingQr: () => account.pairingQr(),
    checkPairing: () => account.checkPairing(),
    scanPairing: async () => {
      const { text } = await ClipplyNative.scanQr();
      return text ? account.pairWithQr(text) : null;
    },
    confirmApproval: (id) => account.confirmApproval(id),
    revoke: (id) => account.revoke(id),
    rename: (id, name) => account.rename(id, name),
    replaceRecoveryKey: () => account.replaceRecoveryKey(),
    setSyncPaused: async (paused) => {
      await account.setSyncPaused(paused);
      await ClipplyNative.setBackgroundUpload({ enabled: !paused });
    },
  };

  return {
    client,
    account: accountClient,
    updates,
    get deviceId() {
      return vault.deviceId;
    },
    settings: () => settings,
    async updateSettings(patch) {
      const next = MobileSettings.parse({ ...settings, ...patch });
      if (patch.screenshots !== undefined) {
        const { granted } = await ClipplyNative.setScreenshotWatch({ enabled: next.screenshots && next.monitoring });
        if (next.screenshots && !granted) next.screenshots = false;
      }
      if (patch.monitoring === false) await ClipplyNative.setScreenshotWatch({ enabled: false });
      settings = next;
      await kv.set('settings.mobile', settings);
      if (patch.checkUpdates) autoCheckUpdates();
      if (patch.retentionDays && settings.retentionDays > 0) await library.applyRetention(settings.retentionDays * 86_400_000);
      return settings;
    },
    captureNow: readClipboard,
    async exportBackup(passphrase) {
      const { data, count, skipped } = await exportBackup(library, passphrase);
      const { saved } = await ClipplyNative.saveDocument({ name: `clipply-${new Date().toISOString().slice(0, 10)}.clipply`, data: bytesToB64(data) });
      return saved ? { count, skipped } : null;
    },
    async importBackup(passphrase) {
      const { data } = await ClipplyNative.openDocument();
      return data ? importBackup(library, b64ToBytes(data), passphrase) : null;
    },
  };
}

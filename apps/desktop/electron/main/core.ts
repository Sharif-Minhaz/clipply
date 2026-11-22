import { writeFile } from 'node:fs/promises';
import { fromUtf8 } from '@clipply/crypto';
import { kvRepo, type SqlDb } from '@clipply/database';
import type { Logger } from '@clipply/logger';
import { ClipLibrary, ContentTooLargeError, htmlToText, type CaptureInput, type LinkPreview, type ManualInput } from '@clipply/sync-engine';

import type { ClipboardProvider, DecodedImage } from './clipboard/provider';
import { loadSettings, saveSettings, type Settings, type SettingsPatch } from './settings';

/** What the main process writes to the OS clipboard (Electron does the actual write). */
export type ClipboardWrite = { text: string; html?: string } | { png: Uint8Array };

export interface CoreDeps {
  db: SqlDb;
  library: ClipLibrary;
  provider: ClipboardProvider;
  writeClipboard: (data: ClipboardWrite) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  /** Native save dialog; null when cancelled. */
  chooseSavePath?: (defaultName: string) => Promise<string | null>;
  /** Starts/stops the screenshot watcher for the current settings. */
  applyScreenshots: (settings: Settings) => void;
  applyAutostart: (enabled: boolean) => void;
  /** Open Graph preview for a URL (cached, public hosts only). */
  linkPreview?: (url: string) => Promise<LinkPreview | null>;
  /** Thumbnail + pixels for an image added by hand; null when it cannot be decoded. */
  decodeImage?: (data: Uint8Array) => DecodedImage | null;
  /** Window classes of the focused app, null when unknown (see clipboard/activeApp.ts). */
  activeApp?: () => Promise<string[] | null>;
  log: Logger;
  now?: () => number;
}

const DAY = 86_400_000;

/**
 * Main-process application logic behind IPC: capture routing, user actions and settings.
 * Electron specifics are injected so this is unit-tested in plain Node.
 */
export class DesktopCore {
  private settingsValue: Settings | null = null;
  private retentionTimer: ReturnType<typeof setInterval> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: CoreDeps) {
    deps.provider.onClipboardChanged((input) => void this.capture(input, 'clipboard'));
  }

  get settings(): Settings {
    if (!this.settingsValue) throw new Error('DesktopCore.start() has not run');
    return this.settingsValue;
  }

  async start(): Promise<void> {
    this.settingsValue = await loadSettings(kvRepo(this.deps.db));
    await this.deps.library.load();
    await this.applySettings();
    await this.runRetention();
    this.retentionTimer = setInterval(() => void this.runRetention(), 6 * 3_600_000);
  }

  async stop(): Promise<void> {
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    await this.deps.provider.stop();
  }

  onStatusChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Logs ids and kinds only, never content. */
  async capture(input: CaptureInput, source: 'clipboard' | 'screenshot'): Promise<void> {
    if (!this.settings.monitoring) return;
    if (input.type === 'image' && !this.settings.captureImages) return;
    // Clipboard changes are seen within one poll of the copy, so the focused app is the source in practice.
    const excluded = this.settings.excludedApps;
    if (source === 'clipboard' && excluded.length > 0 && this.deps.activeApp) {
      const app = await this.deps.activeApp();
      if (app?.some((c) => excluded.includes(c))) return void this.deps.log.debug('skipped copy from excluded app');
    }
    try {
      const res = await this.deps.library.capture(input);
      if (res) this.deps.log.info('captured', { id: res.id, kind: input.type, source, duplicate: res.duplicate });
    } catch (error) {
      if (error instanceof ContentTooLargeError) this.deps.log.warn('skipped oversize item', { kind: input.type, source });
      else this.deps.log.error('capture failed', { error, kind: input.type, source });
    }
  }

  /**
   * Adds text, an image or a file the user picked (the + button). An explicit action, so it ignores
   * the monitoring pause and image-capture setting. An image that cannot be decoded is kept as a file.
   */
  async add(input: ManualInput): Promise<{ duplicate: boolean }> {
    let capture: CaptureInput;
    if (input.type === 'text') capture = { type: 'text', text: input.text };
    else {
      const decoded = input.type === 'image' ? (this.deps.decodeImage?.(input.data) ?? null) : null;
      capture = decoded
        ? { type: 'image', mime: input.mime, data: input.data, pixels: decoded.pixels, thumb: decoded.thumb }
        : { type: 'file', mime: input.mime, data: input.data, name: input.name };
    }
    const res = await this.deps.library.capture(capture);
    if (!res) throw new Error('nothing to add: the text is empty');
    this.deps.log.info('added by hand', { id: res.id, kind: capture.type, duplicate: res.duplicate });
    return { duplicate: res.duplicate };
  }

  /** Copies an item back to the OS clipboard and tells the provider so it is not re-captured. */
  async copy(id: string): Promise<void> {
    const view = this.deps.library.get(id);
    if (!view) throw new Error('item not found');
    const body = await this.deps.library.readBody(id);
    if (view.meta.kind === 'file') throw new Error('files cannot be put back on the clipboard; use Save instead');
    if (view.meta.kind === 'image') await this.deps.writeClipboard({ png: body });
    else if (view.meta.kind === 'html') {
      const html = fromUtf8(body);
      await this.deps.writeClipboard({ text: htmlToText(html), html });
    } else await this.deps.writeClipboard({ text: fromUtf8(body) });
    await this.deps.provider.markCurrentAsSeen();
  }

  /** Preview for a link item; null when turned off in settings or the item is not a link. */
  async linkPreview(id: string): Promise<LinkPreview | null> {
    const view = this.deps.library.get(id);
    if (!this.settings.linkPreviews || !this.deps.linkPreview || view?.meta.kind !== 'url') return null;
    return this.deps.linkPreview(fromUtf8(await this.deps.library.readBody(id)).trim());
  }

  async openUrl(id: string): Promise<void> {
    const view = this.deps.library.get(id);
    if (view?.meta.kind !== 'url') throw new Error('item is not a link');
    const url = new URL(fromUtf8(await this.deps.library.readBody(id)).trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('only http(s) links can be opened');
    await this.deps.openExternal(url.toString());
  }

  /** Explicit user export of an item's contents (files, images); false when cancelled. */
  async saveFile(id: string): Promise<boolean> {
    const view = this.deps.library.get(id);
    if (!view || !this.deps.chooseSavePath) throw new Error('item not found');
    const path = await this.deps.chooseSavePath(view.meta.file?.name ?? (view.meta.kind === 'image' ? 'image.png' : 'clip.txt'));
    if (!path) return false;
    await writeFile(path, await this.deps.library.readBody(id), { mode: 0o600 });
    return true;
  }

  async updateSettings(patch: SettingsPatch): Promise<Settings> {
    const before = this.settings;
    this.settingsValue = await saveSettings(kvRepo(this.deps.db), before, patch);
    if (patch.launchAtLogin !== undefined && patch.launchAtLogin !== before.launchAtLogin) {
      this.deps.applyAutostart(this.settings.launchAtLogin);
    }
    await this.applySettings();
    if (patch.retentionDays !== undefined) await this.runRetention();
    return this.settings;
  }

  private async applySettings(): Promise<void> {
    if (this.settings.monitoring) await this.deps.provider.start();
    else await this.deps.provider.stop();
    this.deps.applyScreenshots(this.settings);
    for (const l of this.listeners) l();
  }

  private async runRetention(): Promise<void> {
    const days = this.settings.retentionDays;
    if (days <= 0) return;
    try {
      const removed = await this.deps.library.applyRetention(days * DAY);
      if (removed > 0) this.deps.log.info('retention removed items', { removed });
    } catch (error) {
      this.deps.log.error('retention failed', { error });
    }
  }
}

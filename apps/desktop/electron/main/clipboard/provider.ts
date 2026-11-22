import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_CAPTURE_BYTES, type CaptureInput } from '@clipply/sync-engine';
import type { Logger } from '@clipply/logger';

/** Common shape for every clipboard backend (Electron/X11 now; XFixes or GNOME Shell later). */
export interface ClipboardProvider {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  onClipboardChanged(callback: (input: CaptureInput) => void): void;
  readCurrentClipboard(): Promise<CaptureInput | null>;
  /** Treat the current clipboard as already seen (after Clipply itself wrote to it). */
  markCurrentAsSeen(): Promise<void>;
}

/** Structural view of Electron 45's async clipboard, so tests can supply a fake. */
export interface ClipboardLike {
  read(): Promise<Array<{ types: string[]; getType(type: string): Promise<unknown> }>>;
}

export interface DecodedImage {
  /** Raw decoded pixels; hashing these makes a PNG file and the same clipboard image equal. */
  pixels: Uint8Array;
  thumb: Uint8Array;
}

export const rawFormat = (f: string): string => `electron application/osclipboard;format="${f}"`;
const PASSWORD_HINT = rawFormat('x-kde-passwordManagerHint');
const TIMESTAMP = rawFormat('TIMESTAMP');

const sha = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');

async function bytesOf(v: unknown): Promise<Uint8Array> {
  if (v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (typeof v === 'string') return new TextEncoder().encode(v);
  throw new TypeError('unexpected clipboard payload');
}

// shortcut: common types only; anything else is application/octet-stream. Upgrade with a mime database if users need more.
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
};
export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** The local path when a `text/uri-list` names exactly one file:// URI (a file copied in a file manager). */
export function singleFilePath(uriList: string): string | null {
  const uris = uriList.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (uris.length !== 1 || !uris[0]!.startsWith('file://')) return null;
  try {
    return fileURLToPath(uris[0]!);
  } catch {
    return null;
  }
}

async function fileInput(path: string): Promise<CaptureInput | null> {
  const s = await stat(path);
  if (!s.isFile() || s.size === 0 || s.size > MAX_CAPTURE_BYTES) return null;
  const name = basename(path);
  return { type: 'file', mime: mimeOf(name), data: new Uint8Array(await readFile(path)), name };
}

const textOf = async (v: unknown): Promise<string> => (typeof v === 'string' ? v : new TextDecoder().decode(await bytesOf(v)));

type Snapshot =
  | { sig: string; read: null }
  | { sig: string; read: () => Promise<CaptureInput | null> };

export interface ElectronProviderOptions {
  clipboard: ClipboardLike;
  decodeImage: (png: Uint8Array) => DecodedImage | null;
  captureImages: () => boolean;
  log: Logger;
  intervalMs?: number;
}

/**
 * Polls Electron's clipboard from the main process. On GNOME Wayland this works unfocused only
 * when Electron runs on XWayland (`--ozone-platform=x11`), because Mutter mirrors the Wayland
 * clipboard into the X selection (measured, docs/desktop.md). A poll reads the type list and the
 * text (a few ms); image bytes are fetched only when the X TIMESTAMP target changes.
 * Plaintext is never kept between polls: change detection compares SHA-256 digests.
 */
export class ElectronClipboardProvider implements ClipboardProvider {
  readonly name = 'electron-x11';
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastSig: string | null = null;
  private polling = false;
  private callback: ((input: CaptureInput) => void) | null = null;

  constructor(private readonly opts: ElectronProviderOptions) {}

  onClipboardChanged(callback: (input: CaptureInput) => void): void {
    this.callback = callback;
  }

  /** The first poll only records a baseline, so restarting the app never re-captures. */
  async start(): Promise<void> {
    if (this.timer) return;
    await this.markCurrentAsSeen();
    this.timer = setInterval(() => void this.poll(), this.opts.intervalMs ?? 750);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async markCurrentAsSeen(): Promise<void> {
    try {
      this.lastSig = (await this.snapshot()).sig;
    } catch (error) {
      this.opts.log.warn('clipboard baseline failed', { error });
    }
  }

  async readCurrentClipboard(): Promise<CaptureInput | null> {
    const snap = await this.snapshot();
    return snap.read ? snap.read() : null;
  }

  /** One polling step; public for tests. Overlapping ticks are skipped. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const snap = await this.snapshot();
      if (snap.sig === this.lastSig) return;
      this.lastSig = snap.sig;
      if (!snap.read) return;
      const input = await snap.read();
      if (input) this.callback?.(input);
    } catch (error) {
      this.opts.log.warn('clipboard poll failed', { error });
    } finally {
      this.polling = false;
    }
  }

  private async snapshot(): Promise<Snapshot> {
    const [item] = await this.opts.clipboard.read();
    if (!item || item.types.length === 0) return { sig: 'empty', read: null };
    const has = (t: string): boolean => item.types.includes(t);

    // Password managers flag secrets; they are never captured.
    if (has(PASSWORD_HINT)) return { sig: 'secret', read: null };

    if (has('image/png') && this.opts.captureImages()) {
      const stamp = has(TIMESTAMP) ? sha(await bytesOf(await item.getType(TIMESTAMP))) : null;
      let png: Uint8Array | null = null;
      const loadPng = async (): Promise<Uint8Array> => (png ??= await bytesOf(await item.getType('image/png')));
      const sig = `img:${stamp ?? sha(await loadPng())}`;
      return {
        sig,
        read: async () => {
          const data = await loadPng();
          const decoded = this.opts.decodeImage(data);
          if (!decoded) return null;
          return { type: 'image', mime: 'image/png', data, pixels: decoded.pixels, thumb: decoded.thumb };
        },
      };
    }
    // One file copied in a file manager: its contents. Several files, folders and oversize files fall back to their paths as text.
    if (has('text/uri-list')) {
      const list = await textOf(await item.getType('text/uri-list'));
      const path = singleFilePath(list);
      const file = path ? await fileInput(path).catch(() => null) : null;
      if (file) return { sig: `file:${sha(list)}`, read: async () => file };
    }
    if (has('text/plain')) {
      const text = await textOf(await item.getType('text/plain'));
      return { sig: `txt:${sha(text)}`, read: async () => ({ type: 'text', text }) };
    }
    if (has('text/html')) {
      const html = await textOf(await item.getType('text/html'));
      return { sig: `html:${sha(html)}`, read: async () => ({ type: 'html', html }) };
    }
    return { sig: `other:${item.types.join(',')}`, read: null };
  }
}

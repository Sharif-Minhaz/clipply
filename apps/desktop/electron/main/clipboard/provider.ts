import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_BYTES } from '@clipply/shared-schemas';
import { classifyText, hasFormatting, type CaptureInput } from '@clipply/sync-engine';
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
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg',
  '.wav': 'audio/wav', '.flac': 'audio/flac', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
};
export const mimeOf = (name: string): string => MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';

/** More files than this in one copy (or more bytes) are somebody moving a folder around, not clips. */
export const MAX_COPIED_FILES = 20;
const MAX_COPIED_BYTES = 200 * 1024 * 1024;
/** HTML larger than this (pages with embedded images) is kept as its plain text. */
const MAX_HTML_BYTES = 512 * 1024;

/** The local paths when a `text/uri-list` names only file:// URIs (files copied in a file manager); empty otherwise. */
export function filePaths(uriList: string): string[] {
  const uris = uriList.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  try {
    return uris.every((u) => u.startsWith('file://')) ? uris.map((u) => fileURLToPath(u)) : [];
  } catch {
    return [];
  }
}

/** A copied file, not read yet. The helper process sends this instead of the contents. */
export interface FileRef {
  type: 'file-ref';
  path: string;
}

/** The copied files worth keeping: folders, empty and oversize ones are left out. */
async function fileRefs(paths: readonly string[], log: Logger): Promise<FileRef[]> {
  if (paths.length > MAX_COPIED_FILES) return [];
  const refs: FileRef[] = [];
  let total = 0;
  for (const path of paths) {
    const s = await stat(path).catch(() => null);
    if (!s?.isFile() || s.size === 0 || s.size > MAX_FILE_BYTES || total + s.size > MAX_COPIED_BYTES) continue;
    total += s.size;
    refs.push({ type: 'file-ref', path });
  }
  if (refs.length > 0 && refs.length < paths.length) log.info('some copied files were skipped', { kept: refs.length, copied: paths.length });
  return refs;
}

export async function loadFile(ref: FileRef): Promise<CaptureInput | null> {
  const s = await stat(ref.path);
  if (!s.isFile() || s.size === 0 || s.size > MAX_FILE_BYTES) return null;
  const name = basename(ref.path);
  return { type: 'file', mime: mimeOf(name), data: new Uint8Array(await readFile(ref.path)), name };
}

const textOf = async (v: unknown): Promise<string> => (typeof v === 'string' ? v : new TextDecoder().decode(await bytesOf(v)));

type Snapshot =
  | { sig: string; read: null }
  | { sig: string; read: () => Promise<Array<CaptureInput | FileRef>> };

export interface ElectronProviderOptions {
  clipboard: ClipboardLike;
  decodeImage: (png: Uint8Array) => DecodedImage | null;
  captureImages: () => boolean;
  /** Receives copied files unread (the helper process); without it they are read here. */
  onFileRef?: (ref: FileRef) => void;
  log: Logger;
  intervalMs?: number;
}

/**
 * Polls Electron's clipboard. On GNOME Wayland this works unfocused only when Electron runs on
 * XWayland (`--ozone-platform=x11`, the clipboard helper process there), because Mutter mirrors the Wayland
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
    const [first] = snap.read ? await snap.read() : [];
    return first?.type === 'file-ref' ? loadFile(first) : (first ?? null);
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
      for (const input of await snap.read()) {
        if (input.type !== 'file-ref') this.callback?.(input);
        else if (this.opts.onFileRef) this.opts.onFileRef(input);
        else {
          const file = await loadFile(input).catch(() => null);
          if (file) this.callback?.(file);
        }
      }
    } catch (error) {
      this.opts.log.warn('clipboard poll failed', { error });
    } finally {
      this.polling = false;
    }
  }

  /** The copy with its formatting, when it has any worth keeping; links and code stay plain text clips. */
  private async formatted(item: Awaited<ReturnType<ClipboardLike['read']>>[number], text: string): Promise<CaptureInput | null> {
    if (!item.types.includes('text/html') || text.trim() === '' || classifyText(text) !== 'text') return null;
    try {
      const html = await textOf(await item.getType('text/html'));
      return html.length <= MAX_HTML_BYTES && hasFormatting(html) ? { type: 'html', html, text } : null;
    } catch {
      // The source went away; its plain text is already here.
      return null;
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
          return decoded ? [{ type: 'image', mime: 'image/png', data, pixels: decoded.pixels, thumb: decoded.thumb }] : [];
        },
      };
    }
    // Files copied in a file manager: their contents, one clip each. Folders, oversize files or too many files fall back to the paths as text.
    if (has('text/uri-list')) {
      const list = await textOf(await item.getType('text/uri-list'));
      const sig = `file:${sha(list)}`;
      // Still the same copy: nothing on disk is touched again.
      if (sig === this.lastSig) return { sig, read: null };
      const refs = await fileRefs(filePaths(list), this.opts.log);
      if (refs.length > 0) return { sig, read: async () => refs };
    }
    if (has('text/plain')) {
      const text = await textOf(await item.getType('text/plain'));
      // The HTML is read only for a new copy; change detection stays on the text.
      return { sig: `txt:${sha(text)}`, read: async () => [(await this.formatted(item, text)) ?? { type: 'text', text }] };
    }
    if (has('text/html')) {
      const html = await textOf(await item.getType('text/html'));
      return { sig: `html:${sha(html)}`, read: async () => [{ type: 'html', html }] };
    }
    return { sig: `other:${item.types.join(',')}`, read: null };
  }
}

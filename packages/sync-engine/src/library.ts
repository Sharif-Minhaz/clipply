import {
  concat, contentHash, CryptoError, fromB64, fromUtf8, generateDek, openChunk, openMeta, openPart, sealChunk, sealMeta, sealPart,
  unwrapDek, utf8, wrapDek, type Keyring,
} from '@clipply/crypto';
import { itemRepo, outboxRepo, Transactor, type ChunkRef, type ItemRow, type SqlDb } from '@clipply/database';
import { CHUNK_BYTES, MAX_CONTENT_BYTES, MAX_FILE_BYTES, type ClipKind, type EncryptedItem, type ItemMeta, type ServerItem } from '@clipply/shared-schemas';

import { chunkCount, type ChunkStore } from './chunks';
import { classifyText, normalizeText, uuidv7 } from './content';
import { htmlToText } from './html';
import { groupSimilarTexts, type TextEntry } from './similar';

export type CaptureInput =
  | { type: 'text'; text: string }
  /** `text`: the plain version the source offered with it (the platform decides which one to keep). */
  | { type: 'html'; html: string; text?: string }
  | {
      type: 'image';
      mime: string;
      data: Uint8Array;
      thumb?: Uint8Array;
      /** Decoded pixels; lets a PNG file and the same screenshot on the clipboard dedupe. */
      pixels?: Uint8Array;
    }
  | { type: 'file'; mime: string; data: Uint8Array; name: string };

/**
 * Something the user adds by hand (the + button). Each platform turns it into a CaptureInput: images
 * get a thumbnail there, and an image the platform cannot decode is kept as a plain file.
 */
export type ManualInput =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file'; name: string; mime: string; data: Uint8Array };

/** Decrypted, display-ready item. Lives in memory only. */
export interface ClipView {
  id: string;
  meta: ItemMeta;
  preview: string;
  hasThumb: boolean;
}

/** Original metadata when re-importing an item from a backup. */
export interface RestoreMeta {
  createdAt: number;
  pinned: boolean;
  favorite: boolean;
  title?: string | undefined;
  /** All recognized text of an image. */
  ocr?: string | undefined;
}

export interface StorageStats {
  count: number;
  /** Plaintext bytes (bodies only; thumbnails and encryption overhead excluded). */
  bytes: number;
  /** Pinned or favorite: never removed by retention or clearing. */
  kept: number;
  byKind: Partial<Record<ClipKind, { count: number; bytes: number }>>;
}

export interface ListFilter {
  kinds?: readonly ClipKind[];
  pinned?: boolean;
  /** Pinned is retired in the UI; a pinned item counts as a favorite. */
  favorite?: boolean;
  query?: string;
  /** Pagination: skip this many matches (newest first), then return at most `limit`. */
  offset?: number;
  limit?: number;
}

/** One page of matches plus how many match in total. */
export interface ClipPage {
  items: ClipView[];
  total: number;
}

export interface LibraryDeps {
  db: SqlDb;
  /** Read on every call so a key rotation takes effect immediately. */
  keyring: () => Keyring;
  deviceId: string;
  now?: () => number;
  /** Downloads a blob body's ciphertext, or one chunk of a large one (set once sync is configured). */
  fetchBlob?: (id: string, chunk?: number) => Promise<Uint8Array>;
  /** Where large bodies are kept; without it nothing over MAX_CAPTURE_BYTES can be stored. */
  chunks?: ChunkStore;
  /** On-device text recognition (OCR) for images, run only when the user asks (`recognize`). */
  recognizeText?: (image: Uint8Array, mime: string) => Promise<string>;
}

/**
 * All recognized text is its own encrypted part (`ocr`), at most this many UTF-8 bytes: padded, sealed and
 * base64-encoded it stays under OCR_MAX. A dense page is well below it.
 */
export const MAX_OCR_BYTES = 24_000;
/**
 * The start of the text is also in the sealed meta, for apps from before the `ocr` part. Meta must stay
 * under EncryptedItem.meta's 4096 base64 chars (2815 bytes of JSON once padded and sealed); this leaves
 * room for a 200-char title.
 */
export const META_OCR_BYTES = 1400;

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー、。「」`;
/** Tesseract puts a space between Japanese characters; Japanese has none. */
const CJK_GAP = new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, 'gu');
const tidyOcr = (text: string): string => text.replace(CJK_GAP, '').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();

const cut = (text: string, fits: (t: string) => boolean): string => {
  let t = tidyOcr(text);
  while (!fits(t)) t = t.slice(0, Math.floor(t.length * 0.9)).trimEnd();
  // Never end inside a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(t) ? t.slice(0, -1) : t;
};

/** Tidies recognized text and cuts it to what the `ocr` part holds. */
export const fitOcr = (text: string): string => cut(text, (t) => utf8(t).length <= MAX_OCR_BYTES);
/** The start that fits the meta (measured as JSON, since that is what is sealed). */
export const fitMetaOcr = (text: string): string => cut(text, (t) => utf8(JSON.stringify(t)).length - 2 <= META_OCR_BYTES);

export type RemoteApplyResult = 'applied' | 'skipped' | 'unknown_epoch';

export class ContentTooLargeError extends Error {
  override name = 'ContentTooLargeError';
}

export class ItemNotFoundError extends Error {
  override name = 'ItemNotFoundError';
}

/** Largest plaintext whose padded ciphertext still fits one Cloudinary raw upload; the limit for text. */
export const MAX_CAPTURE_BYTES = MAX_CONTENT_BYTES;
const PREVIEW_CHARS = 500;
/** Text up to this size is indexed while history loads; larger text right after, in the background. */
const SEARCHABLE_BYTES = 64 * 1024;
/** Large text another device added is downloaded for the index only up to this size; beyond it, when opened. */
const FETCH_TEXT_BYTES = 2 * 1024 * 1024;
/** Characters of large text the index may hold in memory; past that only the start of a text is searchable. */
const LARGE_TEXT_BUDGET = 32 * 1024 * 1024;
const TEXT_KINDS: ReadonlySet<ClipKind> = new Set(['text', 'url', 'code', 'html']);

/** Which of several alike clips to keep: a favorite, else the newest. */
const bestFirst = (a: ClipView, b: ClipView): number =>
  Number(b.meta.favorite || b.meta.pinned) - Number(a.meta.favorite || a.meta.pinned) || b.meta.createdAt - a.meta.createdAt;

interface Entry extends ClipView {
  searchText: string;
}

interface Prepared {
  kind: ClipKind;
  mime: string;
  body: Uint8Array;
  hashSource: Uint8Array;
  thumb?: Uint8Array;
  fileName?: string;
}

function prepare(input: CaptureInput): Prepared | null {
  switch (input.type) {
    case 'text': {
      const norm = normalizeText(input.text);
      if (norm === '') return null;
      return { kind: classifyText(norm), mime: 'text/plain;charset=utf-8', body: utf8(input.text), hashSource: utf8(norm) };
    }
    case 'html': {
      const norm = normalizeText(input.html);
      if (norm === '') return null;
      return { kind: 'html', mime: 'text/html;charset=utf-8', body: utf8(input.html), hashSource: utf8(norm) };
    }
    case 'image':
      return { kind: 'image', mime: input.mime, body: input.data, hashSource: input.pixels ?? input.data, ...(input.thumb ? { thumb: input.thumb } : {}) };
    case 'file':
      return { kind: 'file', mime: input.mime, body: input.data, hashSource: input.data, fileName: input.name };
  }
}

function previewOf(meta: ItemMeta, text: string | null, ocr: string | null): { preview: string; searchText: string } {
  if (meta.kind === 'file') return { preview: meta.file?.name ?? '', searchText: `${meta.title ?? ''} ${meta.file?.name ?? ''}`.toLowerCase() };
  if (text === null) return { preview: '', searchText: `${meta.title ?? ''} ${ocr ?? meta.ocr ?? ''}`.toLowerCase() };
  const plain = meta.kind === 'html' ? htmlToText(text) : text;
  return { preview: plain.slice(0, PREVIEW_CHARS), searchText: `${meta.title ?? ''} ${plain}`.toLowerCase() };
}

/**
 * Local clipboard history: the single place that turns plaintext into stored ciphertext and back.
 * Every write goes through one transaction that updates the item and queues it for sync.
 */
export class ClipLibrary {
  private readonly index = new Map<string, Entry>();
  private readonly corrupt = new Set<string>();
  private readonly listeners = new Set<() => void>();
  /** In-flight blob downloads, so a copy during a background prefetch joins it instead of downloading twice. */
  private readonly bodyFetches = new Map<string, Promise<ItemRow>>();
  /** Text clips whose body is not in the index yet. */
  private readonly unindexed = new Set<string>();
  private indexing: Promise<void> = Promise.resolve();
  private largeChars = 0;
  private swept = false;
  private readonly tx: Transactor;
  private readonly now: () => number;

  constructor(private deps: LibraryDeps) {
    this.tx = new Transactor(deps.db);
    this.now = deps.now ?? Date.now;
  }

  /** New clips are attributed to this id after the device re-registers under a new one. */
  setDeviceId(deviceId: string): void {
    this.deps = { ...this.deps, deviceId };
  }

  /** Decrypts every stored item into the in-memory index. Unreadable items are counted, not thrown. */
  async load(): Promise<void> {
    this.clearIndex();
    const items = itemRepo(this.deps.db);
    // Ciphertext of a searchable body is at most SEARCHABLE_BYTES plus padding and AEAD overhead.
    const maxBody = SEARCHABLE_BYTES + 8192;
    let page = await items.listForIndex(500, undefined, maxBody);
    while (page.length > 0) {
      for (const row of page) this.indexRow(row, row.hasThumb);
      const last = page.at(-1)!;
      page = await items.listForIndex(500, { createdAt: last.createdAt, id: last.id }, maxBody);
    }
    this.emit();
    void this.indexLargeText();
    if (!this.swept) {
      this.swept = true;
      // Leftover files must never keep history from opening.
      await this.sweepChunks().catch(() => undefined);
    }
  }

  private clearIndex(): void {
    this.index.clear();
    this.corrupt.clear();
    this.unindexed.clear();
    this.largeChars = 0;
  }

  /**
   * Reads the text clips that were too large (or not on this device) when history loaded, so their
   * preview and search work too. Runs in the background, newest first; what cannot be read now (offline)
   * stays queued for the next call, which SyncEngine makes after every sync.
   */
  indexLargeText(): Promise<void> {
    this.indexing = this.indexing.then(async () => {
      const ids = [...this.unindexed].sort((a, b) => (this.index.get(b)?.meta.createdAt ?? 0) - (this.index.get(a)?.meta.createdAt ?? 0));
      let done = 0;
      for (const id of ids) {
        const size = this.index.get(id)?.meta.size;
        if (size === undefined || !this.unindexed.has(id)) continue;
        try {
          const row = size <= FETCH_TEXT_BYTES ? await this.cacheBody(id) : await this.requireRow(id);
          if (!row.body) continue;
          this.indexRow(row);
          // Show progress without redrawing the list for every clip.
          if (++done % 10 === 0) this.emit();
        } catch {
          // Gone, offline or unreadable; opening the clip reports the reason.
        }
      }
      if (done % 10 > 0) this.emit();
    });
    return this.indexing;
  }

  /** Chunks whose item is gone (the app closed between the two writes). */
  private async sweepChunks(): Promise<void> {
    const store = this.deps.chunks;
    if (!store) return;
    for (const id of await store.ids()) {
      const row = await itemRepo(this.deps.db).get(id);
      if (!row?.chunks) await store.remove(id);
    }
  }

  /** Forgets the chunks of removed items; a failure only leaves files for the next sweep. */
  private async dropChunks(ids: Iterable<string>): Promise<void> {
    for (const id of ids) await this.deps.chunks?.remove(id).catch(() => undefined);
  }

  get corruptCount(): number {
    return this.corrupt.size;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Keyed hash a clipboard provider can use to recognise content the app itself just wrote. */
  hashOf(input: CaptureInput): string | null {
    const p = prepare(input);
    return p ? this.hash(p) : null;
  }

  /**
   * Stores a new clipboard event. Identical content already in history is moved to the top
   * instead of duplicated. Returns null for empty content.
   */
  async capture(input: CaptureInput, restore?: RestoreMeta): Promise<{ id: string; duplicate: boolean } | null> {
    const p = prepare(input);
    if (!p) return null;
    const store = this.deps.chunks;
    const large = p.body.length > MAX_CAPTURE_BYTES;
    const limit = store && !TEXT_KINDS.has(p.kind) ? MAX_FILE_BYTES : MAX_CAPTURE_BYTES;
    if (p.body.length > limit) throw new ContentTooLargeError(`content exceeds ${limit} bytes`);
    const hash = this.hash(p);
    const now = this.now();
    const createdAt = restore?.createdAt ?? now;
    const id = uuidv7(now);
    const dek = generateDek();
    const count = large ? chunkCount(p.body.length) : 0;
    const ocr = p.kind === 'image' && restore?.ocr !== undefined ? fitOcr(restore.ocr) : null;

    // Chunks are written before the transaction, so a large file does not hold up other writes.
    const isNew = !large || !(await itemRepo(this.deps.db).findLiveByHash(hash));
    if (large && isNew) {
      try {
        for (let i = 0; i < count; i++) await store!.put(id, i, sealChunk(dek, id, i, count, p.body.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES)));
      } catch (error) {
        await this.dropChunks([id]);
        throw error;
      }
    }

    const result = await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const existing = await items.findLiveByHash(hash);
      if (existing) {
        if (restore) {
          // A restored copy of something already here only adds recognized text it did not have.
          if (ocr !== null && !existing.ocr) await this.saveOcr(db, existing, ocr, now);
          return { id: existing.id, duplicate: true };
        }
        const { dek: existingDek, meta } = this.openRow(existing);
        const bumped: ItemMeta = { ...meta, createdAt: now };
        await this.save(db, { ...existing, meta: sealMeta(existingDek, existing.id, bumped), createdAt: now }, now);
        return { id: existing.id, duplicate: true };
      }
      // Deleted between the first look and now: the chunks were not written.
      if (large && !isNew) throw new Error('the clip was removed while it was being saved again; copy it once more');
      const ring = this.deps.keyring();
      const wrapped = wrapDek(ring, id, dek);
      const pinned = restore?.pinned ?? false;
      const favorite = restore?.favorite ?? false;
      const meta: ItemMeta = {
        kind: p.kind, mime: p.mime, createdAt, originDeviceId: this.deps.deviceId, size: p.body.length,
        contentHash: hash, favorite, pinned, ...(p.fileName ? { file: { name: p.fileName } } : {}),
        ...(restore?.title ? { title: restore.title } : {}),
        ...(ocr !== null ? { ocr: fitMetaOcr(ocr) } : {}),
      };
      await this.save(db, {
        id, keyEpoch: wrapped.keyEpoch, dek: wrapped.dek, meta: sealMeta(dek, id, meta),
        body: large ? null : sealPart(dek, id, 'body', p.body), thumb: p.thumb ? sealPart(dek, id, 'thumb', p.thumb) : null,
        blobKey: null, blobSize: null, ocr: ocr !== null ? sealPart(dek, id, 'ocr', utf8(ocr)) : null,
        chunks: large ? Array.from({ length: count }, () => null) : null,
        contentHash: hash, createdAt, pinned, favorite,
        deleted: false, rev: 0, seq: null, syncState: 'pending', updatedAt: now,
      }, now);
      return { id, duplicate: false };
    });
    if (large && result.id !== id) await this.dropChunks([id]);
    await this.reindex(result.id);
    return result;
  }

  /** Stores recognized text: all of it in the `ocr` part ('' too, so a scan that finds nothing replaces an older result), its start in the meta. */
  private async saveOcr(db: SqlDb, row: ItemRow, text: string, now: number): Promise<void> {
    const { dek, meta } = this.openRow(row);
    const full = fitOcr(text);
    await this.save(db, { ...row, meta: sealMeta(dek, row.id, { ...meta, ocr: fitMetaOcr(full) }), ocr: sealPart(dek, row.id, 'ocr', utf8(full)) }, now);
  }

  /**
   * Recognizes the text in an image item on this device (the viewer's "Copy text"; never automatic) and
   * stores it with the item, so it syncs and becomes searchable. Resolves with all of the text ('' = none);
   * the stored copy is cut to MAX_OCR_BYTES (about 8 000 Bengali or 24 000 Latin characters).
   */
  async recognize(id: string): Promise<string> {
    const view = this.get(id);
    if (view?.meta.kind !== 'image') throw new TypeError('only images have text to recognize');
    if (!this.deps.recognizeText) throw new Error('text recognition is not available on this device');
    const full = tidyOcr(await this.deps.recognizeText(await this.readBody(id), view.meta.mime));
    const text = fitOcr(full);
    await this.tx.transaction(async (db) => {
      const row = await this.requireRow(id, db);
      if (this.ocrPart(row) !== text) await this.saveOcr(db, row, text, this.now());
    });
    await this.reindex(id);
    return full;
  }

  /** All recognized text of an image; '' when it was scanned and has none, null when it was never scanned. */
  async readOcr(id: string): Promise<string | null> {
    const row = await this.requireRow(id);
    // Scanned by an app from before the `ocr` part: only the start, in the meta.
    return this.ocrPart(row) ?? this.openRow(row).meta.ocr ?? null;
  }

  private ocrPart(row: ItemRow): string | null {
    return row.ocr ? fromUtf8(openPart(this.openRow(row).dek, row.id, 'ocr', row.ocr)) : null;
  }

  list(filter: ListFilter = {}): ClipView[] {
    return this.page(filter).items;
  }

  /**
   * Matches newest first, cut to `offset`/`limit`, so only one page leaves the library (IPC, the WebView
   * bridge). Filtering runs on the decrypted in-memory index: kind, text and title are encrypted in
   * SQLite, so SQL cannot filter or search them.
   */
  page(filter: ListFilter = {}): ClipPage {
    const q = filter.query?.trim().toLowerCase();
    const out: ClipView[] = [];
    for (const e of this.index.values()) {
      if (filter.kinds && !filter.kinds.includes(e.meta.kind)) continue;
      if (filter.pinned !== undefined && e.meta.pinned !== filter.pinned) continue;
      if (filter.favorite !== undefined && (e.meta.favorite || e.meta.pinned) !== filter.favorite) continue;
      if (q && !e.searchText.includes(q)) continue;
      out.push({ id: e.id, meta: e.meta, preview: e.preview, hasThumb: e.hasThumb });
    }
    out.sort((a, b) => b.meta.createdAt - a.meta.createdAt || (b.id < a.id ? -1 : 1));
    const from = filter.offset ?? 0;
    return { items: filter.limit ? out.slice(from, from + filter.limit) : out.slice(from), total: out.length };
  }

  /**
   * Groups of text clips that say nearly the same (see similar.ts), best one first: favorites, then newest.
   * Only bodies on this device are compared.
   */
  async similarTexts(): Promise<ClipView[][]> {
    const entries: TextEntry[] = [];
    for (const { id, meta } of this.list({ kinds: [...TEXT_KINDS] })) {
      const row = await itemRepo(this.deps.db).get(id);
      if (!row?.body || row.deleted) continue;
      const text = fromUtf8(openPart(this.openRow(row).dek, id, 'body', row.body));
      entries.push({ id, kind: meta.kind, text: meta.kind === 'html' ? htmlToText(text) : text });
    }
    const groups = (await groupSimilarTexts(entries)).map((ids) => ids.flatMap((id) => this.get(id) ?? []).sort(bestFirst));
    return groups.filter((g) => g.length > 1).sort((a, b) => b[0]!.meta.createdAt - a[0]!.meta.createdAt);
  }

  get(id: string): ClipView | undefined {
    const e = this.index.get(id);
    return e && { id: e.id, meta: e.meta, preview: e.preview, hasThumb: e.hasThumb };
  }

  /** Full plaintext body, decrypted on demand. Callers must not persist it. */
  async readBody(id: string): Promise<Uint8Array> {
    const parts: Uint8Array[] = [];
    for await (const part of this.bodyParts(id)) parts.push(part);
    return parts.length === 1 ? parts[0]! : concat(...parts);
  }

  /** The plaintext body piece by piece (one piece unless it is large), so a big file can be saved without holding all of it. */
  async *bodyParts(id: string): AsyncGenerator<Uint8Array> {
    const row = await this.cacheBody(id);
    const { dek } = this.openRow(row);
    if (!row.chunks) {
      if (!row.body) throw new ItemNotFoundError(`body of ${id} is not stored locally`);
      yield openPart(dek, id, 'body', row.body);
      return;
    }
    for (let i = 0; i < row.chunks.length; i++) {
      const data = await this.deps.chunks?.get(id, i);
      if (!data) throw new ItemNotFoundError(`part ${i + 1} of ${id} is not stored locally`);
      yield openChunk(dek, id, i, row.chunks.length, data);
    }
  }

  /** Downloads a blob body (every missing chunk of a large one) into the local cache; returns the row. */
  async cacheBody(id: string): Promise<ItemRow> {
    const row = await this.requireRow(id);
    if (!row.chunks && (row.body || !row.blobKey)) return row;
    if (!this.deps.fetchBlob) return row;
    let pending = this.bodyFetches.get(id);
    if (!pending) {
      pending = this.downloadBody(row).finally(() => this.bodyFetches.delete(id));
      this.bodyFetches.set(id, pending);
    }
    return pending;
  }

  private async downloadBody(row: ItemRow): Promise<ItemRow> {
    if (row.chunks) {
      const store = this.deps.chunks;
      const { dek } = this.openRow(row);
      for (const [i, ref] of row.chunks.entries()) {
        if (!store || !ref || (await store.has(row.id, i))) continue;
        const data = await this.deps.fetchBlob!(row.id, i);
        openChunk(dek, row.id, i, row.chunks.length, data);
        // Removed while downloading: keep nothing.
        const still = await itemRepo(this.deps.db).get(row.id);
        if (!still || still.deleted) throw new ItemNotFoundError(`item ${row.id} not found`);
        await store.put(row.id, i, data);
      }
      return row;
    }
    const ciphertext = await this.deps.fetchBlob!(row.id);
    // Authenticate before caching: a tampered download fails here and is never stored.
    openPart(this.openRow(row).dek, row.id, 'body', ciphertext);
    const fresh = await itemRepo(this.deps.db).get(row.id);
    if (fresh && !fresh.deleted && fresh.blobKey === row.blobKey) await itemRepo(this.deps.db).put({ ...fresh, body: ciphertext });
    return { ...row, body: ciphertext };
  }

  async readThumb(id: string): Promise<Uint8Array | null> {
    const row = await this.requireRow(id);
    return row.thumb ? openPart(this.openRow(row).dek, id, 'thumb', row.thumb) : null;
  }

  async editText(id: string, text: string): Promise<void> {
    const now = this.now();
    await this.tx.transaction(async (db) => {
      const row = await this.requireRow(id, db);
      const { dek, meta } = this.openRow(row);
      if (!TEXT_KINDS.has(meta.kind)) throw new TypeError(`items of kind ${meta.kind} cannot be edited as text`);
      const p = prepare(meta.kind === 'html' ? { type: 'html', html: text } : { type: 'text', text });
      if (!p) throw new TypeError('edited text is empty');
      if (p.body.length > MAX_CAPTURE_BYTES) throw new ContentTooLargeError(`content exceeds ${MAX_CAPTURE_BYTES} bytes`);
      const hash = this.hash(p);
      const next: ItemMeta = { ...meta, kind: p.kind, size: p.body.length, contentHash: hash, editedAt: now };
      // A new body means the uploaded blob (if any) is stale; the next push uploads a fresh one.
      await this.save(db, { ...row, meta: sealMeta(dek, id, next), body: sealPart(dek, id, 'body', p.body), contentHash: hash, blobKey: null, blobSize: null }, now);
    });
    await this.reindex(id);
  }

  async setFlags(id: string, flags: { pinned?: boolean; favorite?: boolean; title?: string }): Promise<void> {
    const now = this.now();
    await this.tx.transaction(async (db) => {
      const row = await this.requireRow(id, db);
      const { dek, meta } = this.openRow(row);
      const defined = Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined));
      const next: ItemMeta = { ...meta, ...defined };
      await this.save(db, { ...row, meta: sealMeta(dek, id, next), pinned: next.pinned, favorite: next.favorite }, now);
    });
    await this.reindex(id);
  }

  /** Never-synced items vanish immediately; synced ones become tombstones queued for the server. */
  async remove(ids: readonly string[]): Promise<void> {
    const now = this.now();
    const chunked: string[] = [];
    await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const outbox = outboxRepo(db);
      for (const id of ids) {
        const row = await items.get(id);
        if (!row || row.deleted) continue;
        if (row.chunks) chunked.push(id);
        await items.markDeleted(id, now);
        // shortcut: an upsert already in flight may still create this item server-side; Phase 5's ack handler must re-queue a delete when it finds no local row.
        if (row.rev === 0 && row.seq === null) {
          await outbox.removeForItem(id);
          await items.purge(id);
        } else {
          await outbox.enqueue(id, 'delete', crypto.randomUUID(), now);
        }
      }
    });
    for (const id of ids) {
      this.dropEntry(id);
      this.corrupt.delete(id);
    }
    this.emit();
    await this.dropChunks(chunked);
  }

  /** Deletes all history and queued changes on this device only; nothing is sent (leaving an account). */
  async forgetAll(): Promise<void> {
    await this.tx.transaction(async (db) => {
      await outboxRepo(db).deleteAll();
      await itemRepo(db).deleteAll();
    });
    this.clearIndex();
    this.emit();
    await this.sweepChunks().catch(() => undefined);
  }

  /**
   * Moves local history from `previous` to the keyring now returned by `deps.keyring()` (a device
   * joining an existing account vault). Only the 72-byte DEK wrappers change, plus text hashes so
   * cross-device dedupe works; bodies and images are not re-encrypted. Every item is queued for sync.
   * Image hashes keep their old value (pixels are not stored), so an image can duplicate once.
   */
  async adoptKeyring(previous: Keyring): Promise<number> {
    const now = this.now();
    let moved = 0;
    await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      let page = await items.list(500);
      while (page.length > 0) {
        for (const row of page) {
          let dek: Uint8Array;
          let meta: ItemMeta;
          try {
            dek = unwrapDek(previous, row.id, { keyEpoch: row.keyEpoch, dek: row.dek });
            meta = openMeta(dek, row.id, row.meta);
          } catch (error) {
            if (error instanceof CryptoError) continue;
            throw error;
          }
          let hash = row.contentHash;
          if (TEXT_KINDS.has(meta.kind) && row.body) {
            const text = fromUtf8(openPart(dek, row.id, 'body', row.body));
            const p = prepare(meta.kind === 'html' ? { type: 'html', html: text } : { type: 'text', text });
            if (p) hash = this.hash(p);
          }
          const wrapped = wrapDek(this.deps.keyring(), row.id, dek);
          await this.save(db, { ...row, keyEpoch: wrapped.keyEpoch, dek: wrapped.dek, contentHash: hash, meta: sealMeta(dek, row.id, { ...meta, contentHash: hash }) }, now);
          moved++;
        }
        const last = page.at(-1)!;
        page = await items.list(500, { createdAt: last.createdAt, id: last.id });
      }
    });
    await this.load();
    return moved;
  }

  // ── sync-facing operations (called by SyncEngine) ──────────────────────────────────────────

  /** Raw stored row (ciphertext), for building push payloads. */
  async row(id: string): Promise<ItemRow | null> {
    return itemRepo(this.deps.db).get(id);
  }

  /**
   * Records an uploaded blob for the current body ciphertext; sync state is unchanged. null forgets every upload
   * of the item, so it is uploaded again — only if its body is here, or the reference would be lost for good.
   */
  async setBlobRef(id: string, key: string | null, size: number | null): Promise<void> {
    await this.tx.transaction(async (db) => {
      const row = await itemRepo(db).get(id);
      if (!row || row.deleted) return;
      if (key === null && !row.body && !(row.chunks && (await this.deps.chunks?.has(id, 0)))) return;
      await itemRepo(db).put({ ...row, blobKey: key, blobSize: size, chunks: key === null ? row.chunks?.map(() => null) ?? null : row.chunks });
    });
  }

  /** Records one uploaded chunk, so an interrupted upload continues where it stopped. */
  async setChunkRef(id: string, index: number, ref: NonNullable<ChunkRef>): Promise<void> {
    await this.tx.transaction(async (db) => {
      const row = await itemRepo(db).get(id);
      if (!row?.chunks || row.deleted) return;
      await itemRepo(db).put({ ...row, chunks: row.chunks.map((c, i) => (i === index ? ref : c)), ...(index === 0 ? { blobKey: ref.key, blobSize: ref.size } : {}) });
    });
  }

  /** Ciphertext of one chunk, if it is on this device. */
  async readChunk(id: string, index: number): Promise<Uint8Array | null> {
    return (await this.deps.chunks?.get(id, index)) ?? null;
  }

  /** Server accepted `opId`. A newer local edit queued meanwhile keeps the item pending. */
  async ackPush(id: string, opId: string, rev: number, seq: number): Promise<void> {
    await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const outbox = outboxRepo(db);
      await outbox.complete(opId);
      const row = await items.get(id);
      if (!row) return;
      if (row.deleted) {
        if (!(await outbox.forItem(id))) await items.purge(id);
        return;
      }
      const pending = await outbox.forItem(id);
      await items.put({ ...row, rev, seq, syncState: pending ? 'pending' : 'synced' });
    });
  }

  /**
   * Applies one change from a pull. Delete wins over a pending local edit. A pending local edit of a
   * live item is left alone: its push conflicts and `resolveConflict` merges. Equal content on two
   * ids (copied on two devices) keeps the item with the lower seq — deterministic on every device.
   */
  async applyRemote(change: ServerItem): Promise<RemoteApplyResult> {
    const now = this.now();
    const id = change.deleted ? change.id : change.item.id;
    const touched = new Set<string>([id]);
    const result = await this.tx.transaction(async (db): Promise<RemoteApplyResult> => {
      const items = itemRepo(db);
      const outbox = outboxRepo(db);
      const local = await items.get(id);
      if (change.deleted) {
        if (!local) return 'skipped';
        await outbox.removeForItem(id);
        await items.markDeleted(id, now);
        await items.purge(id);
        return 'applied';
      }
      if (local && local.rev >= change.rev) return 'skipped';
      if (await outbox.forItem(id)) return 'skipped';
      const it = change.item;
      if (!this.deps.keyring().keys.has(it.keyEpoch)) return 'unknown_epoch';

      const row = this.rowFromServer(change.item, change.rev, change.seq, now, local);
      await items.put(row);
      if (row.contentHash) {
        for (const other of await items.liveByHash(row.contentHash)) {
          if (other.id === id) continue;
          if (other.seq === null) {
            await outbox.removeForItem(other.id);
            await items.markDeleted(other.id, now);
            await items.purge(other.id);
          } else {
            const loser = other.seq > change.seq ? other.id : id;
            await items.markDeleted(loser, now);
            await outbox.enqueue(loser, 'delete', crypto.randomUUID(), now);
            if (loser === id) break;
          }
          touched.add(other.id);
        }
      }
      return 'applied';
    });
    for (const t of touched) await this.reindex(t);
    await this.dropChunks([...touched].filter((t) => !this.index.has(t) && !this.corrupt.has(t)));
    return result;
  }

  /**
   * Our push lost to a newer server version. Same content → keep the server version and re-apply our
   * flags/title on top. Different content → keep the server version under this id and save our edit
   * as a new item. A server tombstone wins outright. Nothing is silently dropped.
   */
  async resolveConflict(id: string, opId: string, current: ServerItem): Promise<'deleted' | 'merged' | 'forked'> {
    const now = this.now();
    let newId: string | null = null;
    const outcome = await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const outbox = outboxRepo(db);
      await outbox.complete(opId);
      const local = await items.get(id);
      if (current.deleted || !local || local.deleted) {
        await outbox.removeForItem(id);
        if (local) {
          await items.markDeleted(id, now);
          await items.purge(id);
        }
        return 'deleted' as const;
      }
      const mine = this.openRow(local);
      const remote = this.rowFromServer(current.item, current.rev, current.seq, now, local);
      const theirs = this.openRow(remote);
      if (mine.meta.contentHash === theirs.meta.contentHash) {
        const merged: ItemMeta = {
          ...theirs.meta, pinned: mine.meta.pinned, favorite: mine.meta.favorite,
          ...(mine.meta.title !== undefined ? { title: mine.meta.title } : {}),
          ...(theirs.meta.ocr === undefined && mine.meta.ocr !== undefined ? { ocr: mine.meta.ocr } : {}),
        };
        await this.save(db, { ...remote, meta: sealMeta(theirs.dek, id, merged), pinned: merged.pinned, favorite: merged.favorite }, now);
        return 'merged' as const;
      }
      if (local.body) newId = await this.copyAsNew(db, local, mine.dek, mine.meta, now);
      await outbox.removeForItem(id);
      await items.put(remote);
      return 'forked' as const;
    });
    await this.reindex(id);
    if (newId) await this.reindex(newId);
    if (outcome === 'deleted') await this.dropChunks([id]);
    return outcome;
  }

  /**
   * After a full resync from cursor 0: removes synced items the server no longer has (their
   * tombstones were purged while this device was away). Pending local work is kept.
   */
  async dropMissingSynced(seen: ReadonlySet<string>): Promise<number> {
    const now = this.now();
    const gone: string[] = [];
    await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      for (const id of await items.syncedIds()) {
        if (seen.has(id) || (await outboxRepo(db).forItem(id))) continue;
        await items.markDeleted(id, now);
        await items.purge(id);
        gone.push(id);
      }
    });
    for (const id of gone) await this.reindex(id);
    await this.dropChunks(gone);
    return gone.length;
  }

  /** Re-wraps an item's DEK under the current epoch after a `stale_epoch` push result. */
  async rewrapToCurrent(id: string): Promise<void> {
    const now = this.now();
    await this.tx.transaction(async (db) => {
      const row = await itemRepo(db).get(id);
      if (!row || row.deleted) return;
      const { dek } = this.openRow(row);
      const wrapped = wrapDek(this.deps.keyring(), id, dek);
      await this.save(db, { ...row, keyEpoch: wrapped.keyEpoch, dek: wrapped.dek }, now);
    });
  }

  private rowFromServer(item: EncryptedItem, rev: number, seq: number, now: number, local: ItemRow | null): ItemRow {
    const base = {
      id: item.id, keyEpoch: item.keyEpoch, dek: fromB64(item.dek), meta: fromB64(item.meta),
      // Keep a cached blob body only if it is the very same blob.
      body: item.body !== undefined ? fromB64(item.body) : local?.blobKey === item.blob?.key ? local?.body ?? null : null,
      thumb: item.thumb !== undefined ? fromB64(item.thumb) : null,
      blobKey: item.blob?.key ?? null, blobSize: item.blob?.size ?? null,
      // An app from before the `ocr` part pushes without it; an item's key never changes, so ours stays readable.
      ocr: item.ocr !== undefined ? fromB64(item.ocr) : local?.ocr ?? null,
      chunks: item.chunks ?? null,
      deleted: false, rev, seq, syncState: 'synced' as const, updatedAt: now,
    };
    try {
      const meta = openMeta(unwrapDek(this.deps.keyring(), item.id, { keyEpoch: item.keyEpoch, dek: base.dek }), item.id, base.meta);
      return { ...base, contentHash: meta.contentHash, createdAt: meta.createdAt, pinned: meta.pinned, favorite: meta.favorite };
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      // Stored as received; it shows up as unreadable rather than vanishing.
      return { ...base, contentHash: '', createdAt: now, pinned: false, favorite: false };
    }
  }

  /** Re-encrypts an item under a fresh id (AAD binds ciphertexts to the id, so everything is resealed). */
  private async copyAsNew(db: SqlDb, row: ItemRow, dek: Uint8Array, meta: ItemMeta, now: number): Promise<string> {
    const id = uuidv7(now);
    const body = openPart(dek, row.id, 'body', row.body!);
    const thumb = row.thumb ? openPart(dek, row.id, 'thumb', row.thumb) : null;
    const newDek = generateDek();
    const wrapped = wrapDek(this.deps.keyring(), id, newDek);
    const copy: ItemMeta = { ...meta, createdAt: now, title: meta.title ?? 'Edited copy' };
    await this.save(db, {
      ...row, id, keyEpoch: wrapped.keyEpoch, dek: wrapped.dek, meta: sealMeta(newDek, id, copy),
      body: sealPart(newDek, id, 'body', body), thumb: thumb ? sealPart(newDek, id, 'thumb', thumb) : null,
      blobKey: null, blobSize: null, ocr: null, chunks: null, createdAt: now, rev: 0, seq: null,
    }, now);
    return id;
  }

  stats(): StorageStats {
    const out: StorageStats = { count: 0, bytes: 0, kept: 0, byKind: {} };
    for (const { meta } of this.index.values()) {
      const k = (out.byKind[meta.kind] ??= { count: 0, bytes: 0 });
      k.count++;
      k.bytes += meta.size;
      out.count++;
      out.bytes += meta.size;
      if (meta.pinned || meta.favorite) out.kept++;
    }
    return out;
  }

  /** Deletes every unpinned, non-favorite item (of `kinds`, if given). Returns how many were removed. */
  async clear(kinds?: readonly ClipKind[]): Promise<number> {
    const ids = this.list(kinds ? { kinds } : {}).filter((v) => !v.meta.pinned && !v.meta.favorite).map((v) => v.id);
    if (ids.length > 0) await this.remove(ids);
    return ids.length;
  }

  /** Deletes unpinned, non-favorite items older than `maxAgeMs`. Returns how many were removed. */
  async applyRetention(maxAgeMs: number): Promise<number> {
    const ids = await itemRepo(this.deps.db).expiredIds(this.now() - maxAgeMs);
    if (ids.length > 0) await this.remove(ids);
    return ids.length;
  }

  private hash(p: Prepared): string {
    return contentHash(this.deps.keyring(), utf8(`${p.kind === 'image' ? 'image' : p.kind === 'file' ? 'file' : 'text'}\0`), p.hashSource);
  }

  private openRow(row: ItemRow): { dek: Uint8Array; meta: ItemMeta } {
    const dek = unwrapDek(this.deps.keyring(), row.id, { keyEpoch: row.keyEpoch, dek: row.dek });
    return { dek, meta: openMeta(dek, row.id, row.meta) };
  }

  private async requireRow(id: string, db: SqlDb = this.deps.db): Promise<ItemRow> {
    const row = await itemRepo(db).get(id);
    if (!row || row.deleted) throw new ItemNotFoundError(`item ${id} not found`);
    return row;
  }

  private async save(db: SqlDb, row: ItemRow, now: number): Promise<void> {
    await itemRepo(db).put({ ...row, syncState: 'pending', updatedAt: now });
    await outboxRepo(db).enqueue(row.id, 'upsert', crypto.randomUUID(), now);
  }

  private async reindex(id: string): Promise<void> {
    const row = await itemRepo(this.deps.db).get(id);
    if (row && !row.deleted) this.indexRow(row);
    else this.dropEntry(id);
    this.emit();
  }

  private dropEntry(id: string): void {
    this.largeChars -= this.largeSize(id);
    this.index.delete(id);
    this.unindexed.delete(id);
  }

  /** What an entry counts against LARGE_TEXT_BUDGET. */
  private largeSize(id: string): number {
    const n = this.index.get(id)?.searchText.length ?? 0;
    return n > SEARCHABLE_BYTES ? n : 0;
  }

  private indexRow(row: ItemRow, hasThumb = row.thumb !== null): void {
    try {
      const { dek, meta } = this.openRow(row);
      const isText = TEXT_KINDS.has(meta.kind);
      const text = isText && row.body ? fromUtf8(openPart(dek, row.id, 'body', row.body)) : null;
      const ocr = row.ocr ? fromUtf8(openPart(dek, row.id, 'ocr', row.ocr)) : null;
      const old = this.index.get(row.id);
      const next = previewOf(meta, text, ocr);
      this.largeChars -= this.largeSize(row.id);
      if (next.searchText.length > SEARCHABLE_BYTES && this.largeChars + next.searchText.length > LARGE_TEXT_BUDGET) {
        next.searchText = next.searchText.slice(0, SEARCHABLE_BYTES);
      }
      if (isText && text === null) {
        this.unindexed.add(row.id);
        // The body is elsewhere but its text was read before (the same content, e.g. after a flag change).
        if (old && old.meta.contentHash === meta.contentHash) {
          next.preview = old.preview;
          next.searchText += old.searchText;
        }
      } else this.unindexed.delete(row.id);
      this.index.set(row.id, { id: row.id, meta, hasThumb, ...next });
      this.largeChars += this.largeSize(row.id);
      this.corrupt.delete(row.id);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      this.dropEntry(row.id);
      this.corrupt.add(row.id);
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

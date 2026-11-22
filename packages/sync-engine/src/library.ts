import {
  concat, contentHash, CryptoError, fromUtf8, generateDek, openMeta, openPart, sealMeta, sealPart,
  unwrapDek, utf8, wrapDek, type Keyring,
} from '@clipply/crypto';
import { itemRepo, outboxRepo, Transactor, type ItemRow, type SqlDb } from '@clipply/database';
import { MAX_BLOB_BYTES, type ClipKind, type ItemMeta } from '@clipply/shared-schemas';

import { classifyText, htmlToText, normalizeText, uuidv7 } from './content';

export type CaptureInput =
  | { type: 'text'; text: string }
  | { type: 'html'; html: string }
  | {
      type: 'image';
      mime: string;
      data: Uint8Array;
      thumb?: Uint8Array;
      /** Decoded pixels; lets a PNG file and the same screenshot on the clipboard dedupe. */
      pixels?: Uint8Array;
    }
  | { type: 'file'; mime: string; data: Uint8Array; name: string };

/** Decrypted, display-ready item. Lives in memory only. */
export interface ClipView {
  id: string;
  meta: ItemMeta;
  preview: string;
  hasThumb: boolean;
}

export interface ListFilter {
  kinds?: readonly ClipKind[];
  pinned?: boolean;
  favorite?: boolean;
  query?: string;
  limit?: number;
}

export interface LibraryDeps {
  db: SqlDb;
  /** Read on every call so a key rotation takes effect immediately. */
  keyring: () => Keyring;
  deviceId: string;
  now?: () => number;
}

export class ContentTooLargeError extends Error {
  override name = 'ContentTooLargeError';
}

export class ItemNotFoundError extends Error {
  override name = 'ItemNotFoundError';
}

/** Largest plaintext whose padded ciphertext still fits one Cloudinary raw upload. */
export const MAX_CAPTURE_BYTES = MAX_BLOB_BYTES - 65_536 - 64;
const PREVIEW_CHARS = 500;
const SEARCHABLE_BYTES = 64 * 1024;
const TEXT_KINDS: ReadonlySet<ClipKind> = new Set(['text', 'url', 'code', 'html']);

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

function previewOf(meta: ItemMeta, text: string | null): { preview: string; searchText: string } {
  if (meta.kind === 'file') return { preview: meta.file?.name ?? '', searchText: `${meta.title ?? ''} ${meta.file?.name ?? ''}`.toLowerCase() };
  if (text === null) return { preview: '', searchText: (meta.title ?? '').toLowerCase() };
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
  private readonly tx: Transactor;
  private readonly now: () => number;

  constructor(private readonly deps: LibraryDeps) {
    this.tx = new Transactor(deps.db);
    this.now = deps.now ?? Date.now;
  }

  /** Decrypts every stored item into the in-memory index. Unreadable items are counted, not thrown. */
  async load(): Promise<void> {
    this.index.clear();
    this.corrupt.clear();
    const items = itemRepo(this.deps.db);
    let page = await items.list(500);
    while (page.length > 0) {
      for (const row of page) this.indexRow(row);
      const last = page.at(-1)!;
      page = await items.list(500, { createdAt: last.createdAt, id: last.id });
    }
    this.emit();
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
  async capture(input: CaptureInput): Promise<{ id: string; duplicate: boolean } | null> {
    const p = prepare(input);
    if (!p) return null;
    if (p.body.length > MAX_CAPTURE_BYTES) throw new ContentTooLargeError(`content exceeds ${MAX_CAPTURE_BYTES} bytes`);
    const hash = this.hash(p);
    const now = this.now();

    const result = await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const existing = await items.findLiveByHash(hash);
      if (existing) {
        const { dek, meta } = this.openRow(existing);
        const bumped: ItemMeta = { ...meta, createdAt: now };
        await this.save(db, { ...existing, meta: sealMeta(dek, existing.id, bumped), createdAt: now }, now);
        return { id: existing.id, duplicate: true };
      }
      const id = uuidv7(now);
      const ring = this.deps.keyring();
      const dek = generateDek();
      const wrapped = wrapDek(ring, id, dek);
      const meta: ItemMeta = {
        kind: p.kind, mime: p.mime, createdAt: now, originDeviceId: this.deps.deviceId, size: p.body.length,
        contentHash: hash, favorite: false, pinned: false, ...(p.fileName ? { file: { name: p.fileName } } : {}),
      };
      await this.save(db, {
        id, keyEpoch: wrapped.keyEpoch, dek: wrapped.dek, meta: sealMeta(dek, id, meta),
        body: sealPart(dek, id, 'body', p.body), thumb: p.thumb ? sealPart(dek, id, 'thumb', p.thumb) : null,
        blobKey: null, blobSize: null, contentHash: hash, createdAt: now, pinned: false, favorite: false,
        deleted: false, rev: 0, seq: null, syncState: 'pending', updatedAt: now,
      }, now);
      return { id, duplicate: false };
    });
    await this.reindex(result.id);
    return result;
  }

  list(filter: ListFilter = {}): ClipView[] {
    const q = filter.query?.trim().toLowerCase();
    const out: ClipView[] = [];
    for (const e of this.index.values()) {
      if (filter.kinds && !filter.kinds.includes(e.meta.kind)) continue;
      if (filter.pinned !== undefined && e.meta.pinned !== filter.pinned) continue;
      if (filter.favorite !== undefined && e.meta.favorite !== filter.favorite) continue;
      if (q && !e.searchText.includes(q)) continue;
      out.push({ id: e.id, meta: e.meta, preview: e.preview, hasThumb: e.hasThumb });
    }
    out.sort((a, b) => b.meta.createdAt - a.meta.createdAt || (b.id < a.id ? -1 : 1));
    return filter.limit ? out.slice(0, filter.limit) : out;
  }

  get(id: string): ClipView | undefined {
    const e = this.index.get(id);
    return e && { id: e.id, meta: e.meta, preview: e.preview, hasThumb: e.hasThumb };
  }

  /** Full plaintext body, decrypted on demand. Callers must not persist it. */
  async readBody(id: string): Promise<Uint8Array> {
    const row = await this.requireRow(id);
    if (!row.body) throw new ItemNotFoundError(`body of ${id} is not stored locally`);
    return openPart(this.openRow(row).dek, id, 'body', row.body);
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
      await this.save(db, { ...row, meta: sealMeta(dek, id, next), body: sealPart(dek, id, 'body', p.body), contentHash: hash }, now);
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
    await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const outbox = outboxRepo(db);
      for (const id of ids) {
        const row = await items.get(id);
        if (!row || row.deleted) continue;
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
      this.index.delete(id);
      this.corrupt.delete(id);
    }
    this.emit();
  }

  /** Deletes unpinned, non-favorite items older than `maxAgeMs`. Returns how many were removed. */
  async applyRetention(maxAgeMs: number): Promise<number> {
    const ids = await itemRepo(this.deps.db).expiredIds(this.now() - maxAgeMs);
    if (ids.length > 0) await this.remove(ids);
    return ids.length;
  }

  private hash(p: Prepared): string {
    return contentHash(this.deps.keyring(), concat(utf8(`${p.kind === 'image' ? 'image' : p.kind === 'file' ? 'file' : 'text'}\0`), p.hashSource));
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
    else this.index.delete(id);
    this.emit();
  }

  private indexRow(row: ItemRow): void {
    try {
      const { dek, meta } = this.openRow(row);
      let text: string | null = null;
      if (TEXT_KINDS.has(meta.kind) && row.body && meta.size <= SEARCHABLE_BYTES) {
        text = fromUtf8(openPart(dek, row.id, 'body', row.body));
      }
      this.index.set(row.id, { id: row.id, meta, hasThumb: row.thumb !== null, ...previewOf(meta, text) });
      this.corrupt.delete(row.id);
    } catch (error) {
      if (!(error instanceof CryptoError)) throw error;
      this.index.delete(row.id);
      this.corrupt.add(row.id);
    }
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

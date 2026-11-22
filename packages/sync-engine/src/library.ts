import {
  concat, contentHash, CryptoError, fromB64, fromUtf8, generateDek, openMeta, openPart, sealMeta, sealPart,
  unwrapDek, utf8, wrapDek, type Keyring,
} from '@clipply/crypto';
import { itemRepo, outboxRepo, Transactor, type ItemRow, type SqlDb } from '@clipply/database';
import { MAX_BLOB_BYTES, type ClipKind, type EncryptedItem, type ItemMeta, type ServerItem } from '@clipply/shared-schemas';

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

/** Original metadata when re-importing an item from a backup. */
export interface RestoreMeta {
  createdAt: number;
  pinned: boolean;
  favorite: boolean;
  title?: string | undefined;
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
  /** Downloads a blob body's ciphertext (set once sync is configured). */
  fetchBlob?: (id: string) => Promise<Uint8Array>;
}

export type RemoteApplyResult = 'applied' | 'skipped' | 'unknown_epoch';

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
    // Ciphertext of a searchable body is at most SEARCHABLE_BYTES plus padding and AEAD overhead.
    const maxBody = SEARCHABLE_BYTES + 8192;
    let page = await items.listForIndex(500, undefined, maxBody);
    while (page.length > 0) {
      for (const row of page) this.indexRow(row, row.hasThumb);
      const last = page.at(-1)!;
      page = await items.listForIndex(500, { createdAt: last.createdAt, id: last.id }, maxBody);
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
  async capture(input: CaptureInput, restore?: RestoreMeta): Promise<{ id: string; duplicate: boolean } | null> {
    const p = prepare(input);
    if (!p) return null;
    if (p.body.length > MAX_CAPTURE_BYTES) throw new ContentTooLargeError(`content exceeds ${MAX_CAPTURE_BYTES} bytes`);
    const hash = this.hash(p);
    const now = this.now();
    const createdAt = restore?.createdAt ?? now;

    const result = await this.tx.transaction(async (db) => {
      const items = itemRepo(db);
      const existing = await items.findLiveByHash(hash);
      if (existing) {
        // A restored copy of something already here changes nothing.
        if (restore) return { id: existing.id, duplicate: true };
        const { dek, meta } = this.openRow(existing);
        const bumped: ItemMeta = { ...meta, createdAt: now };
        await this.save(db, { ...existing, meta: sealMeta(dek, existing.id, bumped), createdAt: now }, now);
        return { id: existing.id, duplicate: true };
      }
      const id = uuidv7(now);
      const ring = this.deps.keyring();
      const dek = generateDek();
      const wrapped = wrapDek(ring, id, dek);
      const pinned = restore?.pinned ?? false;
      const favorite = restore?.favorite ?? false;
      const meta: ItemMeta = {
        kind: p.kind, mime: p.mime, createdAt, originDeviceId: this.deps.deviceId, size: p.body.length,
        contentHash: hash, favorite, pinned, ...(p.fileName ? { file: { name: p.fileName } } : {}),
        ...(restore?.title ? { title: restore.title } : {}),
      };
      await this.save(db, {
        id, keyEpoch: wrapped.keyEpoch, dek: wrapped.dek, meta: sealMeta(dek, id, meta),
        body: sealPart(dek, id, 'body', p.body), thumb: p.thumb ? sealPart(dek, id, 'thumb', p.thumb) : null,
        blobKey: null, blobSize: null, contentHash: hash, createdAt, pinned, favorite,
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
    let row = await this.requireRow(id);
    if (!row.body && row.blobKey && this.deps.fetchBlob) {
      const ciphertext = await this.deps.fetchBlob(id);
      // Authenticate before caching: a tampered download fails here and is never stored.
      openPart(this.openRow(row).dek, id, 'body', ciphertext);
      const fresh = await itemRepo(this.deps.db).get(id);
      if (fresh && !fresh.deleted && fresh.blobKey === row.blobKey) await itemRepo(this.deps.db).put({ ...fresh, body: ciphertext });
      row = { ...row, body: ciphertext };
    }
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

  /** Records an uploaded blob for the current body ciphertext; sync state is unchanged. */
  async setBlobRef(id: string, key: string | null, size: number | null): Promise<void> {
    await this.tx.transaction(async (db) => {
      const row = await itemRepo(db).get(id);
      if (row && !row.deleted) await itemRepo(db).put({ ...row, blobKey: key, blobSize: size });
    });
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
      blobKey: null, blobSize: null, createdAt: now, rev: 0, seq: null,
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

  private indexRow(row: ItemRow, hasThumb = row.thumb !== null): void {
    try {
      const { dek, meta } = this.openRow(row);
      let text: string | null = null;
      if (TEXT_KINDS.has(meta.kind) && row.body && meta.size <= SEARCHABLE_BYTES) {
        text = fromUtf8(openPart(dek, row.id, 'body', row.body));
      }
      this.index.set(row.id, { id: row.id, meta, hasThumb, ...previewOf(meta, text) });
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

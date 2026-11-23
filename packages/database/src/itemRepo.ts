import type { SqlDb, SqlValue } from './sqlDb';

export type SyncState = 'local' | 'pending' | 'synced' | 'conflict';

/** A stored item. Every Uint8Array is ciphertext. */
export interface ItemRow {
  id: string;
  keyEpoch: number;
  dek: Uint8Array;
  meta: Uint8Array;
  body: Uint8Array | null;
  thumb: Uint8Array | null;
  blobKey: string | null;
  blobSize: number | null;
  contentHash: string;
  createdAt: number;
  pinned: boolean;
  favorite: boolean;
  deleted: boolean;
  rev: number;
  seq: number | null;
  syncState: SyncState;
  updatedAt: number;
}

interface RawRow {
  id: string;
  key_epoch: number;
  dek: Uint8Array;
  meta: Uint8Array;
  body: Uint8Array | null;
  thumb: Uint8Array | null;
  blob_key: string | null;
  blob_size: number | null;
  content_hash: string;
  created_at: number;
  pinned: number;
  favorite: number;
  deleted: number;
  rev: number;
  seq: number | null;
  sync_state: SyncState;
  updated_at: number;
}

const fromRaw = (r: RawRow): ItemRow => ({
  id: r.id,
  keyEpoch: r.key_epoch,
  dek: r.dek,
  meta: r.meta,
  body: r.body,
  thumb: r.thumb,
  blobKey: r.blob_key,
  blobSize: r.blob_size,
  contentHash: r.content_hash,
  createdAt: r.created_at,
  pinned: r.pinned === 1,
  favorite: r.favorite === 1,
  deleted: r.deleted === 1,
  rev: r.rev,
  seq: r.seq,
  syncState: r.sync_state,
  updatedAt: r.updated_at,
});

const COLUMNS =
  'id, key_epoch, dek, meta, body, thumb, blob_key, blob_size, content_hash, created_at, pinned, favorite, deleted, rev, seq, sync_state, updated_at';

const toParams = (i: ItemRow): SqlValue[] => [
  i.id, i.keyEpoch, i.dek, i.meta, i.body, i.thumb, i.blobKey, i.blobSize, i.contentHash, i.createdAt,
  i.pinned ? 1 : 0, i.favorite ? 1 : 0, i.deleted ? 1 : 0, i.rev, i.seq, i.syncState, i.updatedAt,
];

export interface ListCursor {
  createdAt: number;
  id: string;
}

export function itemRepo(db: SqlDb) {
  return {
    /** Insert or replace the whole row (local capture, edits, and remote changes). */
    async put(item: ItemRow): Promise<void> {
      await db.run(`INSERT OR REPLACE INTO items (${COLUMNS}) VALUES (${COLUMNS.split(',').map(() => '?').join(',')})`, toParams(item));
    },

    async get(id: string): Promise<ItemRow | null> {
      const [row] = await db.query<RawRow>(`SELECT ${COLUMNS} FROM items WHERE id = ?`, [id]);
      return row ? fromRaw(row) : null;
    },

    /**
     * Like `list`, for building an in-memory index: thumbnails are left out (only `hasThumb`), and
     * bodies larger than `maxBodyBytes` come back null. On Android every byte crosses the WebView
     * bridge as JSON, so loading image bodies here made startup take seconds.
     */
    async listForIndex(limit: number, after: ListCursor | undefined, maxBodyBytes: number): Promise<Array<ItemRow & { hasThumb: boolean }>> {
      const cols = COLUMNS.replace('body, thumb', 'CASE WHEN length(body) <= ? THEN body END AS body, NULL AS thumb, thumb IS NOT NULL AS has_thumb');
      const rows = after
        ? await db.query<RawRow & { has_thumb: number }>(
            `SELECT ${cols} FROM items WHERE deleted = 0 AND (created_at, id) < (?, ?) ORDER BY created_at DESC, id DESC LIMIT ?`,
            [maxBodyBytes, after.createdAt, after.id, limit],
          )
        : await db.query<RawRow & { has_thumb: number }>(
            `SELECT ${cols} FROM items WHERE deleted = 0 ORDER BY created_at DESC, id DESC LIMIT ?`,
            [maxBodyBytes, limit],
          );
      return rows.map((r) => ({ ...fromRaw(r), hasThumb: r.has_thumb === 1 }));
    },

    /** Newest first, keyset-paginated so pages stay stable while new items arrive. */
    async list(limit: number, after?: ListCursor): Promise<ItemRow[]> {
      const rows = after
        ? await db.query<RawRow>(
            `SELECT ${COLUMNS} FROM items WHERE deleted = 0 AND (created_at, id) < (?, ?)
             ORDER BY created_at DESC, id DESC LIMIT ?`,
            [after.createdAt, after.id, limit],
          )
        : await db.query<RawRow>(
            `SELECT ${COLUMNS} FROM items WHERE deleted = 0 ORDER BY created_at DESC, id DESC LIMIT ?`,
            [limit],
          );
      return rows.map(fromRaw);
    },

    async findLiveByHash(contentHash: string): Promise<ItemRow | null> {
      const [row] = await db.query<RawRow>(
        `SELECT ${COLUMNS} FROM items WHERE deleted = 0 AND content_hash = ? ORDER BY created_at DESC LIMIT 1`,
        [contentHash],
      );
      return row ? fromRaw(row) : null;
    },

    async syncedIds(): Promise<string[]> {
      const rows = await db.query<{ id: string }>('SELECT id FROM items WHERE deleted = 0 AND seq IS NOT NULL');
      return rows.map((r) => r.id);
    },

    /** Every live item with this keyed hash (cross-device duplicates). */
    async liveByHash(contentHash: string): Promise<ItemRow[]> {
      const rows = await db.query<RawRow>(`SELECT ${COLUMNS} FROM items WHERE deleted = 0 AND content_hash = ?`, [contentHash]);
      return rows.map(fromRaw);
    },

    /** Tombstone: ciphertext dropped now, row kept until the server acknowledges the delete. */
    async markDeleted(id: string, now: number): Promise<void> {
      await db.run(
        `UPDATE items SET deleted = 1, body = NULL, thumb = NULL, meta = X'', dek = X'', updated_at = ? WHERE id = ?`,
        [now, id],
      );
    },

    /** Deletes every row, tombstones included (local only: nothing is queued for sync). */
    async deleteAll(): Promise<void> {
      await db.run('DELETE FROM items');
    },

    /** Removes tombstones nobody needs any more (never synced, or delete acknowledged). */
    async purge(id: string): Promise<void> {
      await db.run('DELETE FROM items WHERE id = ? AND deleted = 1', [id]);
    },

    /** Ids of live, unpinned, non-favorite items older than `cutoff`, for retention. */
    async expiredIds(cutoff: number): Promise<string[]> {
      const rows = await db.query<{ id: string }>(
        'SELECT id FROM items WHERE deleted = 0 AND pinned = 0 AND favorite = 0 AND created_at < ?',
        [cutoff],
      );
      return rows.map((r) => r.id);
    },

    async count(): Promise<number> {
      const [row] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE deleted = 0');
      return row?.n ?? 0;
    },
  };
}

export type ItemRepo = ReturnType<typeof itemRepo>;

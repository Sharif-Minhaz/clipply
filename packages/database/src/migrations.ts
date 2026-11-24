import type { SqlDb } from './sqlDb';

/**
 * Append-only. Never edit a shipped migration; add a new one.
 * Content columns hold ciphertext. The few clear columns (created_at, pinned, favorite,
 * content_hash) exist so retention and dedupe run without decrypting; see docs/architecture.md §4.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE items (
    id            TEXT PRIMARY KEY,
    key_epoch     INTEGER NOT NULL,
    dek           BLOB NOT NULL,
    meta          BLOB NOT NULL,
    body          BLOB,
    thumb         BLOB,
    blob_key      TEXT,
    blob_size     INTEGER,
    content_hash  TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    pinned        INTEGER NOT NULL DEFAULT 0,
    favorite      INTEGER NOT NULL DEFAULT 0,
    deleted       INTEGER NOT NULL DEFAULT 0,
    rev           INTEGER NOT NULL DEFAULT 0,
    seq           INTEGER,
    sync_state    TEXT NOT NULL DEFAULT 'local'
                  CHECK (sync_state IN ('local', 'pending', 'synced', 'conflict')),
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX items_created ON items (deleted, created_at DESC, id DESC);
  CREATE INDEX items_hash ON items (content_hash) WHERE deleted = 0;

  CREATE TABLE outbox (
    op_id           TEXT PRIMARY KEY,
    item_id         TEXT NOT NULL UNIQUE,
    type            TEXT NOT NULL CHECK (type IN ('upsert', 'delete')),
    attempts        INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error      TEXT,
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX outbox_due ON outbox (next_attempt_at);

  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // ocr: all recognized text of an image (ciphertext). chunks: JSON array of {key,size}|null upload refs, set
  // only for bodies too large for one blob; their ciphertext lives in the ChunkStore, not in this table.
  `
  ALTER TABLE items ADD COLUMN ocr BLOB;
  ALTER TABLE items ADD COLUMN chunks TEXT;
  `,
];

export async function migrate(db: SqlDb): Promise<number> {
  await db.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const [row] = await db.query<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  const current = row?.v ?? 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema v${current} is newer than this app (v${MIGRATIONS.length})`);
  }
  for (let version = current + 1; version <= MIGRATIONS.length; version++) {
    await db.execute('BEGIN IMMEDIATE');
    try {
      await db.execute(MIGRATIONS[version - 1]!);
      await db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, Date.now()]);
      await db.execute('COMMIT');
    } catch (error) {
      await db.execute('ROLLBACK');
      throw error;
    }
  }
  return MIGRATIONS.length;
}

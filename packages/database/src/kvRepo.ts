import type { SqlDb } from './sqlDb';

/** Small JSON settings and sync state (cursor, device id, preferences). Never keys or plaintext. */
export function kvRepo(db: SqlDb) {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const [row] = await db.query<{ value: string }>('SELECT value FROM kv WHERE key = ?', [key]);
      return row ? (JSON.parse(row.value) as T) : undefined;
    },

    async set(key: string, value: unknown): Promise<void> {
      await db.run(
        'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
        [key, JSON.stringify(value)],
      );
    },
  };
}

export type KvRepo = ReturnType<typeof kvRepo>;

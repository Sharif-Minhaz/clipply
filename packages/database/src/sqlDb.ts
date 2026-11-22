export type SqlValue = string | number | null | Uint8Array;

/**
 * The one database seam. Desktop wraps better-sqlite3 (main process), Android wraps
 * @capacitor-community/sqlite, tests wrap node:sqlite. Async because the Capacitor bridge is.
 */
export interface SqlDb {
  execute(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  query<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

/**
 * Serializes transactions on a single connection. Without this, two async callers could
 * interleave statements inside each other's BEGIN/COMMIT.
 */
export class Transactor {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly db: SqlDb) {}

  transaction<T>(work: (db: SqlDb) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      await this.db.execute('BEGIN IMMEDIATE');
      try {
        const value = await work(this.db);
        await this.db.execute('COMMIT');
        return value;
      } catch (error) {
        await this.db.execute('ROLLBACK');
        throw error;
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { SqlDb } from './sqlDb';

/** In-memory SQLite for Node tests (no native addon, so no Electron/Node ABI clash). */
export function openTestDb(): SqlDb {
  const db = new DatabaseSync(':memory:');
  return {
    async execute(sql) {
      db.exec(sql);
    },
    async run(sql, params = []) {
      const result = db.prepare(sql).run(...(params as SQLInputValue[]));
      return { changes: Number(result.changes) };
    },
    async query<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
    },
  };
}

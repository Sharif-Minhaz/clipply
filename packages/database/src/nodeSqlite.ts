import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { SqlDb } from './sqlDb';

/**
 * SqlDb over Node's built-in SQLite. Used by the Electron main process (Electron 45 ships
 * node:sqlite, so no native addon or ABI rebuild) and by tests with ':memory:'.
 */
export function openNodeSqlite(path: string): SqlDb & { close(): void } {
  const db = new DatabaseSync(path);
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
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
    close() {
      db.close();
    },
  };
}

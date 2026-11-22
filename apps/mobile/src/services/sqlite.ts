import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import type { SqlDb, SqlValue } from '@clipply/database';

const DB_NAME = 'clipply';

/** The plugin returns BLOBs as number arrays; the shared repos expect Uint8Array. */
function normalize<T>(row: Record<string, unknown>): T {
  for (const [k, v] of Object.entries(row)) if (Array.isArray(v)) row[k] = Uint8Array.from(v as number[]);
  return row as T;
}

/**
 * SqlDb over @capacitor-community/sqlite. Its own implicit transactions are turned off
 * (`transaction: false`) because the shared Transactor issues BEGIN/COMMIT itself.
 */
export async function openCapacitorDb(): Promise<SqlDb> {
  const sqlite = new SQLiteConnection(CapacitorSQLite);
  await sqlite.checkConnectionsConsistency();
  const existing = (await sqlite.isConnection(DB_NAME, false)).result;
  const conn = existing ? await sqlite.retrieveConnection(DB_NAME, false) : await sqlite.createConnection(DB_NAME, false, 'no-encryption', 1, false);
  await conn.open();
  await conn.execute('PRAGMA foreign_keys = ON;', false);
  // The plugin's Java side only binds BLOBs given in Node's Buffer JSON shape (UtilsSQLite.objectJSArrayToArrayList).
  const args = (params: SqlValue[]): unknown[] => params.map((p) => (p instanceof Uint8Array ? { type: 'Buffer', data: Array.from(p) } : p));
  return {
    async execute(sql) {
      await conn.execute(sql, false);
    },
    async run(sql, params = []) {
      const r = await conn.run(sql, args(params), false);
      return { changes: r.changes?.changes ?? 0 };
    },
    async query<T>(sql: string, params: SqlValue[] = []) {
      const rows = (await conn.query(sql, args(params))).values ?? [];
      return rows.map((r) => normalize<T>(r as Record<string, unknown>));
    },
  };
}

import { openNodeSqlite } from './nodeSqlite';
import type { SqlDb } from './sqlDb';

/** In-memory SQLite for Node tests (no native addon, so no Electron/Node ABI clash). */
export const openTestDb = (): SqlDb => openNodeSqlite(':memory:');

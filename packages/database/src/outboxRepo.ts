import type { SqlDb } from './sqlDb';

export type OutboxType = 'upsert' | 'delete';

export interface OutboxRow {
  opId: string;
  itemId: string;
  type: OutboxType;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
}

interface RawRow {
  op_id: string;
  item_id: string;
  type: OutboxType;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
}

const fromRaw = (r: RawRow): OutboxRow => ({
  opId: r.op_id,
  itemId: r.item_id,
  type: r.type,
  attempts: r.attempts,
  nextAttemptAt: r.next_attempt_at,
  lastError: r.last_error,
  createdAt: r.created_at,
});

/** At most one pending op per item; the op reads the item's latest row when it is pushed. */
export function outboxRepo(db: SqlDb) {
  return {
    /**
     * Records that `itemId` needs pushing. A new opId replaces the old one because the payload
     * changed; a pending delete is never downgraded back to an upsert.
     */
    async enqueue(itemId: string, type: OutboxType, opId: string, now: number): Promise<void> {
      await db.run(
        `INSERT INTO outbox (op_id, item_id, type, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, 0, ?, ?)
         ON CONFLICT (item_id) DO UPDATE SET
           op_id = excluded.op_id,
           type = CASE WHEN outbox.type = 'delete' THEN 'delete' ELSE excluded.type END,
           attempts = 0, next_attempt_at = excluded.next_attempt_at, last_error = NULL`,
        [opId, itemId, type, now, now],
      );
    },

    async due(now: number, limit: number): Promise<OutboxRow[]> {
      const rows = await db.query<RawRow>(
        'SELECT * FROM outbox WHERE next_attempt_at <= ? ORDER BY created_at LIMIT ?',
        [now, limit],
      );
      return rows.map(fromRaw);
    },

    async recordFailure(opId: string, error: string, nextAttemptAt: number): Promise<void> {
      await db.run(
        'UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE op_id = ?',
        [error.slice(0, 500), nextAttemptAt, opId],
      );
    },

    /** Only removes the op that was pushed; a newer op for the same item survives. */
    async complete(opId: string): Promise<void> {
      await db.run('DELETE FROM outbox WHERE op_id = ?', [opId]);
    },

    /** Drops whatever is queued for an item (used when a never-synced item is deleted). */
    async removeForItem(itemId: string): Promise<void> {
      await db.run('DELETE FROM outbox WHERE item_id = ?', [itemId]);
    },

    async pendingCount(): Promise<number> {
      const [row] = await db.query<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
      return row?.n ?? 0;
    },
  };
}

export type OutboxRepo = ReturnType<typeof outboxRepo>;

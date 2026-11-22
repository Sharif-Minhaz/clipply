import type { Store } from '../../db';
import type { Logger } from '@clipply/logger';

export const TOMBSTONE_TTL_MS = 30 * 86_400_000;
const ABANDONED_UPLOAD_MS = 86_400_000;

export interface GcResult {
  blobsDestroyed: number;
  blobsFailed: number;
  tombstonesPurged: number;
}

/**
 * Bounded cleanup run by the Vercel cron: destroys released and abandoned blobs, and purges old
 * tombstones while raising each user's purgeFloor so stale cursors resync instead of missing a delete.
 */
export async function runGc(store: Store, destroy: (key: string) => Promise<boolean>, now: number, log: Logger, batch = 50): Promise<GcResult> {
  const result: GcResult = { blobsDestroyed: 0, blobsFailed: 0, tombstonesPurged: 0 };

  const objects = await store.c.objects
    .find({ $or: [{ status: 'delete_pending' }, { status: 'pending', updatedAt: { $lt: new Date(now - ABANDONED_UPLOAD_MS) } }] })
    .limit(batch)
    .toArray();
  for (const o of objects) {
    if (await destroy(o._id).catch(() => false)) {
      await store.c.objects.deleteOne({ _id: o._id });
      result.blobsDestroyed++;
    } else result.blobsFailed++;
  }

  const old = await store.c.items
    .find({ deleted: true, updatedAt: { $lt: new Date(now - TOMBSTONE_TTL_MS) } }, { projection: { userId: 1, seq: 1 } })
    .limit(batch * 10)
    .toArray();
  const floors = new Map<string, number>();
  for (const t of old) floors.set(t.userId, Math.max(floors.get(t.userId) ?? 0, t.seq));
  for (const [userId, floor] of floors) {
    // Raise the floor first: if deletion then fails, clients resync a little early, never miss a delete.
    await store.c.users.updateOne({ _id: userId }, { $max: { purgeFloor: floor } });
  }
  if (old.length > 0) {
    const del = await store.c.items.deleteMany({ _id: { $in: old.map((t) => t._id) } });
    result.tombstonesPurged = del.deletedCount;
  }
  log.info('gc finished', { ...result });
  return result;
}

import type { Store } from '../../db';
import type { Logger } from '@clipply/logger';

export const TOMBSTONE_TTL_MS = 30 * 86_400_000;
const ABANDONED_UPLOAD_MS = 86_400_000;
/**
 * An upload that no item references after this long is an orphan: the item was deleted or edited
 * before its first push landed. Generous so an offline device can still push; if it pushes later
 * anyway, the server answers `blob_not_uploaded` and the client simply re-uploads.
 */
export const ORPHAN_GRACE_MS = 3 * 86_400_000;
/** Vercel's function limit is 30 s (scripts/build-vercel.mjs); stop starting new work well before. */
const TIME_BUDGET_MS = 20_000;
const DESTROY_CONCURRENCY = 5;

export interface GcResult {
  blobsDestroyed: number;
  blobsFailed: number;
  orphansReleased: number;
  tombstonesPurged: number;
}

export interface GcOptions {
  batch?: number;
  /** Wall-clock source for the time budget (separate from `now`, which tests move freely). */
  clock?: () => number;
  budgetMs?: number;
}

/**
 * Cleanup run by the daily Vercel cron: releases orphaned uploads, destroys released and abandoned
 * blobs on Cloudinary, and purges old tombstones while raising each user's purgeFloor so stale
 * cursors resync instead of missing a delete. Works in batches until done or out of time budget;
 * whatever is left is picked up by the next run.
 */
export async function runGc(store: Store, destroy: (key: string) => Promise<boolean>, now: number, log: Logger, opts: GcOptions = {}): Promise<GcResult> {
  const batch = opts.batch ?? 50;
  const clock = opts.clock ?? Date.now;
  const deadline = clock() + (opts.budgetMs ?? TIME_BUDGET_MS);
  const result: GcResult = { blobsDestroyed: 0, blobsFailed: 0, orphansReleased: 0, tombstonesPurged: 0 };

  // 1. Orphans. Objects confirmed before `attached` existed are checked once and promoted if live.
  const orphanCutoff = new Date(now - ORPHAN_GRACE_MS);
  while (clock() < deadline) {
    const candidates = await store.c.objects.find({ status: 'uploaded', updatedAt: { $lt: orphanCutoff } }).limit(batch).toArray();
    for (const o of candidates) {
      const live = await store.c.items.countDocuments({ _id: `${o.userId}:${o.itemId}`, deleted: false, 'item.blob.key': o._id }, { limit: 1 });
      // `status: 'uploaded'` in the filter loses to a push attaching it concurrently (see applyOne).
      const r = await store.c.objects.updateOne(
        { _id: o._id, status: 'uploaded' },
        { $set: { status: live ? 'attached' : 'delete_pending', updatedAt: new Date(now) } },
      );
      if (!live && r.modifiedCount) result.orphansReleased++;
    }
    if (candidates.length < batch) break;
  }

  // 2. Destroy released and abandoned blobs. Failures stay queued and are retried next run; they are
  // skipped for the rest of this run so one broken key cannot spin the loop.
  const failed = new Set<string>();
  while (clock() < deadline) {
    const objects = await store.c.objects
      .find({
        _id: { $nin: [...failed] },
        $or: [{ status: 'delete_pending' }, { status: 'pending', updatedAt: { $lt: new Date(now - ABANDONED_UPLOAD_MS) } }],
      })
      .limit(batch)
      .toArray();
    for (let i = 0; i < objects.length; i += DESTROY_CONCURRENCY) {
      await Promise.all(
        objects.slice(i, i + DESTROY_CONCURRENCY).map(async (o) => {
          if (await destroy(o._id).catch(() => false)) {
            await store.c.objects.deleteOne({ _id: o._id });
            result.blobsDestroyed++;
          } else {
            failed.add(o._id);
            result.blobsFailed++;
          }
        }),
      );
    }
    if (objects.length < batch) break;
  }

  // 3. Tombstones.
  while (clock() < deadline) {
    const old = await store.c.items
      .find({ deleted: true, updatedAt: { $lt: new Date(now - TOMBSTONE_TTL_MS) } }, { projection: { userId: 1, seq: 1 } })
      .limit(batch * 10)
      .toArray();
    if (old.length === 0) break;
    const floors = new Map<string, number>();
    for (const t of old) floors.set(t.userId, Math.max(floors.get(t.userId) ?? 0, t.seq));
    for (const [userId, floor] of floors) {
      // Raise the floor first: if deletion then fails, clients resync a little early, never miss a delete.
      await store.c.users.updateOne({ _id: userId }, { $max: { purgeFloor: floor } });
    }
    const del = await store.c.items.deleteMany({ _id: { $in: old.map((t) => t._id) } });
    result.tombstonesPurged += del.deletedCount;
    if (old.length < batch * 10) break;
  }

  log.info('gc finished', { ...result, outOfTime: clock() >= deadline });
  return result;
}

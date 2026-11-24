import type { ClientSession } from 'mongodb';
import { MAX_SYNC_BYTES, type EncryptedItem, type PullResponse, type PushOp, type PushResult, type ServerItem } from '@clipply/shared-schemas';

import type { ItemDoc, Store } from '../../db';
import { HttpError } from '../../errors';

export function toServerItem(d: ItemDoc): ServerItem {
  const base = { rev: d.rev, seq: d.seq, updatedAt: d.updatedAt.getTime() };
  return d.deleted || !d.item ? { ...base, deleted: true, id: d.itemId } : { ...base, deleted: false, item: d.item };
}

/** Every stored blob an item points at. */
const blobKeys = (item: EncryptedItem | null | undefined): string[] => item?.chunks?.map((c) => c.key) ?? (item?.blob ? [item.blob.key] : []);

/**
 * Fields an app from before they existed leaves out when it only changes flags. An item's data key never
 * changes, so the stored ones still open; `chunks` belong to the same body exactly when the blob is the same.
 */
function keepUnknown(next: EncryptedItem, current: EncryptedItem | null | undefined): EncryptedItem {
  if (!current) return next;
  const out = { ...next };
  if (out.ocr === undefined && current.ocr !== undefined) out.ocr = current.ocr;
  if (out.chunks === undefined && current.chunks && out.blob?.key === current.blob?.key) out.chunks = current.chunks;
  return out;
}

const itemKey = (userId: string, itemId: string): string => `${userId}:${itemId}`;

/**
 * Applies a push batch in ONE transaction. Each accepted op takes the next per-user `seq` from the
 * user document; concurrent pushes conflict on that document and MongoDB retries the loser, so
 * commit order equals seq order and a puller can never skip a change (docs/synchronization.md §1).
 * Conflicts and rejections are per-op results, not aborts.
 */
export async function applyPush(store: Store, userId: string, ops: PushOp[], now: number): Promise<{ results: PushResult[]; releasedBlobs: string[] }> {
  return store.tx(async (session) => {
    const results: PushResult[] = [];
    const releasedBlobs: string[] = [];
    const user = await store.c.users.findOne({ _id: userId }, { session });
    if (!user) throw new HttpError(401, 'unknown_user');

    for (const op of ops) {
      const eventId = itemKey(userId, op.opId);
      const prior = await store.c.syncEvents.findOne({ _id: eventId }, { session });
      if (prior) {
        results.push(prior.result);
        continue;
      }
      const result = await applyOne(store, session, userId, user.keyEpoch, op, now, releasedBlobs);
      await store.c.syncEvents.insertOne({ _id: eventId, result, createdAt: new Date(now) }, { session });
      results.push(result);
    }
    if (releasedBlobs.length > 0) {
      // Same transaction as the delete/replace, so a released blob can never be left looking live.
      // The cron destroys it; serverless functions may freeze after responding.
      await store.c.objects.updateMany(
        { _id: { $in: releasedBlobs }, userId },
        { $set: { status: 'delete_pending', updatedAt: new Date(now) } },
        { session },
      );
    }
    return { results, releasedBlobs };
  });
}

async function nextSeq(store: Store, session: ClientSession, userId: string): Promise<number> {
  const u = await store.c.users.findOneAndUpdate({ _id: userId }, { $inc: { seq: 1 } }, { session, returnDocument: 'after' });
  if (!u) throw new HttpError(401, 'unknown_user');
  return u.seq;
}

async function applyOne(
  store: Store, session: ClientSession, userId: string, keyEpoch: number, op: PushOp, now: number, releasedBlobs: string[],
): Promise<PushResult> {
  const itemId = op.type === 'upsert' ? op.item.id : op.itemId;
  const _id = itemKey(userId, itemId);
  const current = await store.c.items.findOne({ _id }, { session });

  if (op.type === 'delete') {
    // Delete wins and is idempotent. A tombstone is written even for ids never seen, so an upsert
    // still in flight from another device cannot resurrect the item afterwards.
    if (current?.deleted) return { opId: op.opId, status: 'applied', rev: current.rev, seq: current.seq };
    const seq = await nextSeq(store, session, userId);
    const rev = (current?.rev ?? 0) + 1;
    await store.c.items.updateOne(
      { _id },
      { $set: { userId, itemId, rev, seq, deleted: true, item: null, updatedAt: new Date(now) } },
      { upsert: true, session },
    );
    releasedBlobs.push(...blobKeys(current?.item));
    return { opId: op.opId, status: 'applied', rev, seq };
  }

  if (op.item.keyEpoch < keyEpoch) return { opId: op.opId, status: 'stale_epoch', currentEpoch: keyEpoch };
  if (current && (current.deleted || current.rev !== op.baseRev)) {
    return { opId: op.opId, status: 'conflict', current: toServerItem(current) };
  }
  if (!current && op.baseRev !== 0) {
    return { opId: op.opId, status: 'rejected', reason: 'unknown_base_revision' };
  }
  const item = keepUnknown(op.item, current?.item);
  const keys = blobKeys(item);
  if (keys.length > 0) {
    // Conditional write rather than a read: if the GC has just released this blob as an orphan, the
    // filter misses and the client re-uploads; otherwise the GC's own `status: 'uploaded'` filter misses.
    const attached = await store.c.objects.updateMany(
      { _id: { $in: keys }, userId, itemId, status: { $in: ['uploaded', 'attached'] } },
      { $set: { status: 'attached', updatedAt: new Date(now) } },
      { session },
    );
    if (attached.matchedCount !== keys.length) return { opId: op.opId, status: 'rejected', reason: 'blob_not_uploaded' };
  }
  releasedBlobs.push(...blobKeys(current?.item).filter((k) => !keys.includes(k)));

  const seq = await nextSeq(store, session, userId);
  const rev = (current?.rev ?? 0) + 1;
  await store.c.items.updateOne(
    { _id },
    { $set: { userId, itemId, rev, seq, deleted: false, item, updatedAt: new Date(now) } },
    { upsert: true, session },
  );
  return { opId: op.opId, status: 'applied', rev, seq };
}

export async function pull(store: Store, userId: string, cursor: number, limit: number, resync = false): Promise<PullResponse> {
  const user = await store.c.users.findOne({ _id: userId }, { projection: { purgeFloor: 1 } });
  if (!user) throw new HttpError(401, 'unknown_user');
  // A full resync (from cursor 0) is always allowed, all its pages; any other cursor below the floor may have missed a purged delete.
  if (cursor > 0 && !resync && cursor < user.purgeFloor) throw new HttpError(410, 'cursor_expired');
  const docs = await store.c.items.find({ userId, seq: { $gt: cursor } }).sort({ seq: 1 }).limit(limit + 1).toArray();
  const page: ItemDoc[] = [];
  let bytes = 0;
  for (const d of docs.slice(0, limit)) {
    const i = d.item;
    bytes += 500 + (i ? i.meta.length + (i.body?.length ?? 0) + (i.thumb?.length ?? 0) + (i.ocr?.length ?? 0) + (i.chunks?.length ?? 0) * 150 : 0);
    // At least one item, or the page could never advance.
    if (page.length > 0 && bytes > MAX_SYNC_BYTES) break;
    page.push(d);
  }
  return {
    changes: page.map(toServerItem),
    cursor: page.at(-1)?.seq ?? cursor,
    hasMore: docs.length > page.length,
  };
}

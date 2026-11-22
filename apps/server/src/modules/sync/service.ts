import type { ClientSession } from 'mongodb';
import type { PullResponse, PushOp, PushResult, ServerItem } from '@clipply/shared-schemas';

import type { ItemDoc, Store } from '../../db';
import { HttpError } from '../../errors';

export function toServerItem(d: ItemDoc): ServerItem {
  const base = { rev: d.rev, seq: d.seq, updatedAt: d.updatedAt.getTime() };
  return d.deleted || !d.item ? { ...base, deleted: true, id: d.itemId } : { ...base, deleted: false, item: d.item };
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
    if (current?.item?.blob) releasedBlobs.push(current.item.blob.key);
    return { opId: op.opId, status: 'applied', rev, seq };
  }

  if (op.item.keyEpoch < keyEpoch) return { opId: op.opId, status: 'stale_epoch', currentEpoch: keyEpoch };
  if (current && (current.deleted || current.rev !== op.baseRev)) {
    return { opId: op.opId, status: 'conflict', current: toServerItem(current) };
  }
  if (!current && op.baseRev !== 0) {
    return { opId: op.opId, status: 'rejected', reason: 'unknown_base_revision' };
  }
  const blob = op.item.blob;
  if (blob) {
    const obj = await store.c.objects.findOne({ _id: blob.key, userId, itemId, status: 'uploaded' }, { session });
    if (!obj) return { opId: op.opId, status: 'rejected', reason: 'blob_not_uploaded' };
  }
  const oldBlob = current?.item?.blob?.key;
  if (oldBlob && oldBlob !== blob?.key) releasedBlobs.push(oldBlob);

  const seq = await nextSeq(store, session, userId);
  const rev = (current?.rev ?? 0) + 1;
  await store.c.items.updateOne(
    { _id },
    { $set: { userId, itemId, rev, seq, deleted: false, item: op.item, updatedAt: new Date(now) } },
    { upsert: true, session },
  );
  return { opId: op.opId, status: 'applied', rev, seq };
}

export async function pull(store: Store, userId: string, cursor: number, limit: number): Promise<PullResponse> {
  const user = await store.c.users.findOne({ _id: userId }, { projection: { purgeFloor: 1 } });
  if (!user) throw new HttpError(401, 'unknown_user');
  // Cursor 0 is a full resync and always allowed; anything else below the floor may have missed a purged delete.
  if (cursor > 0 && cursor < user.purgeFloor) throw new HttpError(410, 'cursor_expired');
  const docs = await store.c.items.find({ userId, seq: { $gt: cursor } }).sort({ seq: 1 }).limit(limit + 1).toArray();
  const page = docs.slice(0, limit);
  return {
    changes: page.map(toServerItem),
    cursor: page.at(-1)?.seq ?? cursor,
    hasMore: docs.length > limit,
  };
}

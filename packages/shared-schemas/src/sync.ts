import { z } from 'zod';

import { Id, KeyEpoch, Rev, Seq } from './primitives';
import { EncryptedItem, ServerItem } from './item';

export const MAX_PUSH_OPS = 50;
/** JSON size a client aims to stay under per push, and a server per pull page: Vercel caps both bodies at 4.5 MB. */
export const MAX_SYNC_BYTES = 3_000_000;
export const MAX_PULL_LIMIT = 500;

/** `opId` makes a retried push idempotent; the server remembers applied opIds for a while. */
export const PushOp = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('upsert'),
    opId: Id,
    /** Revision the client edited from; 0 for a new item. Mismatch -> conflict. */
    baseRev: Rev,
    item: EncryptedItem,
  }),
  /** Delete wins over concurrent edits, so it carries no baseRev. */
  z.object({ type: z.literal('delete'), opId: Id, itemId: Id }),
]);
export type PushOp = z.infer<typeof PushOp>;

export const PushRequest = z.object({ ops: z.array(PushOp).min(1).max(MAX_PUSH_OPS) });
export type PushRequest = z.infer<typeof PushRequest>;

export const PushResult = z.discriminatedUnion('status', [
  z.object({ opId: Id, status: z.literal('applied'), rev: Rev, seq: Seq }),
  z.object({ opId: Id, status: z.literal('conflict'), current: ServerItem }),
  /** Item was encrypted under a retired vault key; client must refresh its keyring and re-wrap. */
  z.object({ opId: Id, status: z.literal('stale_epoch'), currentEpoch: KeyEpoch }),
  /** Permanently invalid (e.g. references a blob that was never uploaded); retrying will not help. */
  z.object({ opId: Id, status: z.literal('rejected'), reason: z.string().max(100) }),
]);
export type PushResult = z.infer<typeof PushResult>;

export const PushResponse = z.object({ results: z.array(PushResult) });
export type PushResponse = z.infer<typeof PushResponse>;

export const PullQuery = z.object({
  cursor: z.coerce.number().pipe(Seq),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_LIMIT).default(200),
  /** Set on the later pages of a pull that began at cursor 0: it misses no deletes, however old its cursor. */
  resync: z.literal('1').optional(),
});
export type PullQuery = z.infer<typeof PullQuery>;

export const PullResponse = z.object({
  changes: z.array(ServerItem),
  cursor: Seq,
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponse>;

/** Cheap "anything new?" probe so idle clients avoid full pulls. */
export const SyncHead = z.object({
  seq: Seq,
  keyEpoch: KeyEpoch,
  /** What this server supports beyond the base protocol (SERVER_FEATURES); older servers send nothing. */
  features: z.array(z.string().max(32)).max(32).default([]),
});
export type SyncHead = z.infer<typeof SyncHead>;

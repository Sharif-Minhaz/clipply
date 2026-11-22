import type { ClientSession, Collection, Db, MongoClient } from 'mongodb';
import type { Device, EncryptedItem, KeyEnvelope, PushResult, RecoveryEnvelope } from '@clipply/shared-schemas';

export interface UserDoc {
  _id: string;
  googleSub: string;
  email: string;
  /** Per-user change counter; every accepted write takes the next value inside a transaction. */
  seq: number;
  keyEpoch: number;
  /** Tombstones at or below this seq were purged; older cursors must resync from 0. */
  purgeFloor: number;
  /** Set by the first device's vault init; `version` bumps on every envelope change. */
  vault?: { version: number; recovery: RecoveryEnvelope };
  createdAt: Date;
}

export type DeviceDoc = Omit<Device, 'id' | 'createdAt' | 'lastSeenAt' | 'lastSyncAt'> & {
  _id: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  lastSyncAt?: Date;
  /** Pending device claimed by an authorized device that will enroll it. */
  enrollment?: { approverId: string; at: Date };
};

export type EnvelopeDoc = KeyEnvelope & { _id: string; userId: string; updatedAt: Date };

export interface SessionDoc {
  _id: string;
  userId: string;
  deviceId: string;
  tokenHash: string;
  /** The hash this one replaced; presenting it again means the token was stolen. */
  previousHash: string | null;
  revoked: boolean;
  expiresAt: Date;
  createdAt: Date;
}

export interface ItemDoc {
  _id: string;
  userId: string;
  itemId: string;
  rev: number;
  seq: number;
  deleted: boolean;
  item: EncryptedItem | null;
  updatedAt: Date;
}

export interface SyncEventDoc {
  _id: string;
  result: PushResult;
  createdAt: Date;
}

export interface ObjectDoc {
  _id: string;
  userId: string;
  itemId: string;
  size: number;
  status: 'pending' | 'uploaded' | 'delete_pending';
  createdAt: Date;
  updatedAt: Date;
}

export interface RateDoc {
  _id: string;
  n: number;
  expiresAt: Date;
}

export interface Collections {
  users: Collection<UserDoc>;
  devices: Collection<DeviceDoc>;
  sessions: Collection<SessionDoc>;
  items: Collection<ItemDoc>;
  syncEvents: Collection<SyncEventDoc>;
  objects: Collection<ObjectDoc>;
  rateLimits: Collection<RateDoc>;
  envelopes: Collection<EnvelopeDoc>;
}

export interface Store {
  client: MongoClient;
  c: Collections;
  /** Runs `work` in a transaction with MongoDB's automatic retry on transient write conflicts. */
  tx<T>(work: (session: ClientSession) => Promise<T>): Promise<T>;
}

export function createStore(client: MongoClient, db: Db): Store {
  const c: Collections = {
    users: db.collection('users'),
    devices: db.collection('devices'),
    sessions: db.collection('sessions'),
    items: db.collection('clipboard_items'),
    syncEvents: db.collection('sync_events'),
    objects: db.collection('encrypted_objects'),
    rateLimits: db.collection('rate_limits'),
    envelopes: db.collection('device_key_envelopes'),
  };
  return {
    client,
    c,
    async tx(work) {
      const session = client.startSession();
      try {
        return await session.withTransaction(() => work(session), {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
      } finally {
        await session.endSession();
      }
    },
  };
}

/** Idempotent; called once per cold start. */
export async function ensureIndexes(c: Collections): Promise<void> {
  await Promise.all([
    c.users.createIndex({ googleSub: 1 }, { unique: true }),
    c.devices.createIndex({ userId: 1 }),
    c.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    c.sessions.createIndex({ previousHash: 1 }, { sparse: true }),
    c.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.items.createIndex({ userId: 1, seq: 1 }),
    c.items.createIndex({ deleted: 1, updatedAt: 1 }),
    c.syncEvents.createIndex({ createdAt: 1 }, { expireAfterSeconds: 7 * 86_400 }),
    c.objects.createIndex({ userId: 1, itemId: 1 }),
    c.objects.createIndex({ status: 1, updatedAt: 1 }),
    c.rateLimits.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    c.envelopes.createIndex({ userId: 1 }),
  ]);
}

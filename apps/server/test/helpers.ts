import { randomUUID } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import request from 'supertest';
import {
  createKeyring, generateDek, generateDeviceKeys, initCrypto, sealMeta, sealPart, toB64, utf8, wrapDek, type Keyring,
} from '@clipply/crypto';
import { createLogger, type LogRecord } from '@clipply/logger';
import type { AuthResponse, EncryptedItem } from '@clipply/shared-schemas';

import { createApp } from '../src/app';
import type { Config } from '../src/config';
import { createStore, ensureIndexes, type Store } from '../src/db';

export const config: Config = {
  MONGODB_URI: 'mongodb://unused', MONGODB_DB: 'clipply_test', JWT_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_IDS: ['client'],
  CLOUDINARY_CLOUD_NAME: 'demo', CLOUDINARY_API_KEY: '1234', CLOUDINARY_API_SECRET: 'cloud-secret', CRON_SECRET: 'c'.repeat(20),
  CORS_ORIGINS: ['https://localhost'],
};

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: Store;
  logs: LogRecord[];
  clock: { now: number };
  fetchCalls: string[];
  close(): Promise<void>;
}

/** Real MongoDB (in-memory replica set, so transactions work) behind the real Express app. */
export async function startHarness(): Promise<Harness> {
  await initCrypto();
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  const client = new MongoClient(replSet.getUri());
  await client.connect();
  const store = createStore(client, client.db(`t${randomUUID().slice(0, 8)}`));
  await ensureIndexes(store.c);
  const logs: LogRecord[] = [];
  const clock = { now: Date.UTC(2026, 10, 22) };
  const fetchCalls: string[] = [];
  const app = createApp({
    config, store, log: createLogger('test', { sink: (r) => logs.push(r), level: 'debug' }), now: () => clock.now,
    // Google tokens in tests are "google:<sub>:<email>".
    verifyGoogle: async (t) => {
      const [p, sub, email] = t.split(':');
      return p === 'google' && sub && email ? { sub, email } : null;
    },
    fetch: (async (url: string) => {
      fetchCalls.push(String(url));
      return new Response(JSON.stringify({ result: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  return { app, store, logs, clock, fetchCalls, close: async () => { await client.close(); await replSet.stop(); } };
}

export interface TestDevice {
  id: string;
  token: string;
  refresh: string;
  auth: AuthResponse;
}

export async function signIn(h: Harness, sub: string, deviceId: string = randomUUID()): Promise<TestDevice> {
  const keys = generateDeviceKeys();
  const res = await request(h.app).post('/v1/auth/google').send({
    idToken: `google:${sub}:${sub}@example.com`,
    device: { id: deviceId, name: `dev-${deviceId.slice(0, 4)}`, platform: 'ubuntu', appVersion: '0.1.0', keys: { boxPublicKey: toB64(keys.box.publicKey), signPublicKey: toB64(keys.sign.publicKey) } },
  });
  if (res.status !== 200) throw new Error(`sign-in failed ${res.status} ${JSON.stringify(res.body)}`);
  return { id: deviceId, token: res.body.accessToken, refresh: res.body.refreshToken, auth: res.body };
}

/** A genuinely encrypted item (XChaCha20-Poly1305 via @clipply/crypto) with known plaintext. */
export function encryptedItem(ring: Keyring = createKeyring(), text = 'PLAINTEXT-MARKER', id = randomUUID()): EncryptedItem {
  const dek = generateDek();
  const wrapped = wrapDek(ring, id, dek);
  return {
    id, encVersion: 1, keyEpoch: wrapped.keyEpoch, dek: toB64(wrapped.dek),
    meta: toB64(sealMeta(dek, id, {
      kind: 'text', mime: 'text/plain', createdAt: 1, originDeviceId: id, size: text.length, contentHash: 'a'.repeat(64), favorite: false, pinned: false,
    })),
    body: toB64(sealPart(dek, id, 'body', utf8(text))),
  };
}

export const bearer = (d: TestDevice): [string, string] => ['authorization', `Bearer ${d.token}`];

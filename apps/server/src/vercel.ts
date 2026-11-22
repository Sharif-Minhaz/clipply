import type { IncomingMessage, ServerResponse } from 'node:http';
import { MongoClient } from 'mongodb';
import { createLogger } from '@clipply/logger';

import { createApp } from './app';
import { loadConfig } from './config';
import { createStore, ensureIndexes } from './db';
import { googleVerifier } from './modules/auth/google';

const log = createLogger('api');

/**
 * Vercel function entry. The Mongo client and Express app are cached per warm instance;
 * `maxPoolSize` stays small because every concurrent instance opens its own pool against M0.
 */
let ready: Promise<ReturnType<typeof createApp>> | null = null;

async function init(): Promise<ReturnType<typeof createApp>> {
  const config = loadConfig();
  const client = new MongoClient(config.MONGODB_URI, { maxPoolSize: 5, serverSelectionTimeoutMS: 8000, appName: 'clipply-api' });
  await client.connect();
  const store = createStore(client, client.db(config.MONGODB_DB));
  await ensureIndexes(store.c);
  return createApp({ config, store, verifyGoogle: googleVerifier(config.GOOGLE_CLIENT_IDS), log });
}

/**
 * The Build Output route rewrites `/v1/<rest>` to this function as `?__path=<rest>`. Whether or
 * not Vercel hands over the original URL, this yields `/v1/<rest>?<original query>`.
 */
export function restorePath(url: string): string {
  const u = new URL(url, 'http://x');
  const rest = u.searchParams.get('__path');
  if (rest === null) return url;
  u.searchParams.delete('__path');
  const qs = u.searchParams.toString();
  return `/v1/${rest.replace(/^\/+/, '')}${qs ? `?${qs}` : ''}`;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ready ??= init().catch((error: unknown) => {
    ready = null;
    throw error;
  });
  try {
    const app = await ready;
    req.url = restorePath(req.url ?? '/');
    app(req as never, res as never);
  } catch (error) {
    log.error('startup failed', { error });
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":"unavailable"}');
  }
}

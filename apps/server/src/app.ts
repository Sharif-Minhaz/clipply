import express, { Router, type Express } from 'express';
import type { Logger } from '@clipply/logger';

import type { Config } from './config';
import type { Store } from './db';
import { errorHandler, HttpError } from './errors';
import { auth, requireAuthorizedDevice } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import type { GoogleVerifier } from './modules/auth/google';
import { authRoutes } from './modules/auth/routes';
import { clipboardRoutes } from './modules/clipboard/routes';
import { deviceRoutes } from './modules/devices/routes';
import { runGc } from './modules/maintenance/gc';
import { destroy, type CloudinaryConfig } from './modules/storage/cloudinary';
import { storageRoutes } from './modules/storage/routes';
import { syncRoutes } from './modules/sync/routes';
import { vaultRoutes } from './modules/vault/routes';

export interface AppDeps {
  config: Config;
  store: Store;
  verifyGoogle: GoogleVerifier;
  log: Logger;
  now?: () => number;
  fetch?: typeof fetch;
}

/** Stateless: everything lives in MongoDB, so any serverless instance can serve any request. */
export function createApp(d: AppDeps): Express {
  const now = d.now ?? Date.now;
  const { config, store } = d;
  const cloudinary: CloudinaryConfig = {
    cloudName: config.CLOUDINARY_CLOUD_NAME, apiKey: config.CLOUDINARY_API_KEY, apiSecret: config.CLOUDINARY_API_SECRET,
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  app.use((req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    const origin = req.headers.origin;
    if (origin && config.CORS_ORIGINS.includes(origin)) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization, content-type');
      res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, OPTIONS');
      res.setHeader('access-control-max-age', '600');
    }
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  // Pushes are capped by MAX_PUSH_OPS × inline caps (~3.5 MB); Vercel rejects bodies over 4.5 MB.
  app.use(express.json({ limit: '4mb' }));

  const v1 = Router();
  v1.get('/health', async (_req, res) => {
    await store.client.db('admin').command({ ping: 1 });
    res.json({ ok: true });
  });

  v1.use('/auth', rateLimit(store, 'auth', 30, 60, now), authRoutes({ store, verifyGoogle: d.verifyGoogle, jwtSecret: config.JWT_SECRET, now }));

  const authed = Router();
  authed.use(auth(store, config.JWT_SECRET, now));
  authed.use(rateLimit(store, 'api', 600, 60, now));
  authed.use('/devices', deviceRoutes(store, now));
  authed.use('/vault', rateLimit(store, 'vault', 60, 60, now), vaultRoutes(store, now));
  authed.use('/sync', requireAuthorizedDevice, syncRoutes(store, now));
  authed.use('/items', requireAuthorizedDevice, clipboardRoutes(store));
  authed.use('/storage', requireAuthorizedDevice, rateLimit(store, 'storage', 120, 60, now), storageRoutes(store, cloudinary, now));

  // Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`.
  v1.get('/internal/gc', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${config.CRON_SECRET}`) throw new HttpError(401, 'unauthenticated');
    const result = await runGc(store, (key) => destroy(cloudinary, key, Math.floor(now() / 1000), d.fetch), now(), d.log.child('gc'));
    res.json(result);
  });

  v1.use(authed);
  app.use('/v1', v1);
  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler(d.log));
  return app;
}

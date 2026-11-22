import { Router } from 'express';
import { PullQuery, PushRequest, type PushResponse, type SyncHead } from '@clipply/shared-schemas';

import type { Store } from '../../db';
import { HttpError, parse } from '../../errors';
import { requireAuth } from '../../middleware/auth';
import { applyPush, pull } from './service';

export function syncRoutes(store: Store, now: () => number): Router {
  const r = Router();

  r.get('/head', async (req, res) => {
    const { userId } = requireAuth(req);
    const user = await store.c.users.findOne({ _id: userId }, { projection: { seq: 1, keyEpoch: 1 } });
    if (!user) throw new HttpError(401, 'unknown_user');
    const out: SyncHead = { seq: user.seq, keyEpoch: user.keyEpoch };
    res.json(out);
  });

  r.get('/pull', async (req, res) => {
    const { userId, deviceId } = requireAuth(req);
    const q = parse(PullQuery, req.query);
    const out = await pull(store, userId, q.cursor, q.limit);
    await store.c.devices.updateOne({ _id: deviceId }, { $set: { lastSyncAt: new Date(now()) } });
    res.json(out);
  });

  r.post('/push', async (req, res) => {
    const { userId, deviceId } = requireAuth(req);
    const body = parse(PushRequest, req.body);
    const { results } = await applyPush(store, userId, body.ops, now());
    await store.c.devices.updateOne({ _id: deviceId }, { $set: { lastSyncAt: new Date(now()) } });
    const out: PushResponse = { results };
    res.json(out);
  });

  return r;
}

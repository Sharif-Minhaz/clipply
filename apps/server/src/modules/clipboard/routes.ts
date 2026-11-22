import { Router } from 'express';
import { z } from 'zod';

import type { Store } from '../../db';
import { HttpError, parse } from '../../errors';
import { requireAuth } from '../../middleware/auth';
import { toServerItem } from '../sync/service';

/**
 * Single-item read. Creating, editing, pinning, favoriting and deleting all go through
 * /v1/sync/push: flags live inside the encrypted metadata, so the server cannot act on them.
 */
export function clipboardRoutes(store: Store): Router {
  const r = Router();
  r.get('/:id', async (req, res) => {
    const { userId } = requireAuth(req);
    const id = parse(z.uuid(), req.params.id);
    const doc = await store.c.items.findOne({ _id: `${userId}:${id}` });
    if (!doc) throw new HttpError(404, 'item_not_found');
    res.json(toServerItem(doc));
  });
  return r;
}

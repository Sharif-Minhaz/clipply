import { randomBytes } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { ConfirmUploadRequest, UploadSignatureRequest, type DownloadUrlResponse, type UploadSignatureResponse } from '@clipply/shared-schemas';

import type { Store } from '../../db';
import { HttpError, parse } from '../../errors';
import { requireAuth } from '../../middleware/auth';
import { privateDownloadUrl, uploadFields, verifyUploadResponse, type CloudinaryConfig } from './cloudinary';

export function storageRoutes(store: Store, cfg: CloudinaryConfig, now: () => number): Router {
  const r = Router();

  r.post('/upload-signature', async (req, res) => {
    const { userId } = requireAuth(req);
    const { itemId, size } = parse(UploadSignatureRequest, req.body);
    const existing = await store.c.items.findOne({ _id: `${userId}:${itemId}` }, { projection: { deleted: 1 } });
    if (existing?.deleted) throw new HttpError(409, 'item_deleted');
    const key = `clipply/${userId}/${itemId}/${randomBytes(9).toString('base64url')}`;
    const t = new Date(now());
    await store.c.objects.insertOne({ _id: key, userId, itemId, size, status: 'pending', createdAt: t, updatedAt: t });
    const out: UploadSignatureResponse = { key, ...uploadFields(cfg, key, Math.floor(now() / 1000)) };
    res.json(out);
  });

  r.post('/confirm', async (req, res) => {
    const { userId } = requireAuth(req);
    const { key, upload } = parse(ConfirmUploadRequest, req.body);
    if (upload.public_id !== key || !verifyUploadResponse(cfg, upload)) throw new HttpError(400, 'invalid_upload_signature');
    const updated = await store.c.objects.updateOne(
      { _id: key, userId, status: { $in: ['pending', 'uploaded'] } },
      { $set: { status: 'uploaded', size: upload.bytes, updatedAt: new Date(now()) } },
    );
    if (updated.matchedCount === 0) throw new HttpError(404, 'object_not_found');
    res.status(204).end();
  });

  r.get('/download-url', async (req, res) => {
    const { userId } = requireAuth(req);
    const itemId = parse(z.uuid(), req.query.itemId);
    const doc = await store.c.items.findOne({ _id: `${userId}:${itemId}` });
    const key = doc && !doc.deleted ? doc.item?.blob?.key : undefined;
    if (!key) throw new HttpError(404, 'blob_not_found');
    const out: DownloadUrlResponse = privateDownloadUrl(cfg, key, Math.floor(now() / 1000));
    res.json(out);
  });

  return r;
}

import { Router } from 'express';
import { z } from 'zod';
import { RenameDeviceRequest } from '@clipply/shared-schemas';

import type { Store } from '../../db';
import { HttpError, parse } from '../../errors';
import { requireAuth } from '../../middleware/auth';
import { toDevice } from '../auth/routes';

const DeviceId = z.uuid();

export function deviceRoutes(store: Store, now: () => number): Router {
  const r = Router();

  r.get('/', async (req, res) => {
    const { userId } = requireAuth(req);
    const docs = await store.c.devices.find({ userId }).sort({ createdAt: 1 }).toArray();
    res.json({ devices: docs.map(toDevice) });
  });

  r.patch('/:id', async (req, res) => {
    const { userId } = requireAuth(req);
    const id = parse(DeviceId, req.params.id);
    const { name } = parse(RenameDeviceRequest, req.body);
    const updated = await store.c.devices.findOneAndUpdate({ _id: id, userId }, { $set: { name } }, { returnDocument: 'after' });
    if (!updated) throw new HttpError(404, 'device_not_found');
    res.json(toDevice(updated));
  });

  /**
   * Cuts a device off at once: status, sessions and (Phase 4) key envelopes. Only an authorized
   * device may revoke others; any device may revoke itself. The caller must then rotate the vault
   * key so the revoked device cannot read future items (docs/encryption.md §5).
   */
  r.post('/:id/revoke', async (req, res) => {
    const a = requireAuth(req);
    const id = parse(DeviceId, req.params.id);
    if (id !== a.deviceId && a.device.status !== 'authorized') throw new HttpError(403, 'device_not_authorized');
    const at = new Date(now());
    const updated = await store.c.devices.findOneAndUpdate(
      { _id: id, userId: a.userId },
      { $set: { status: 'revoked', lastSeenAt: at, revokedAt: at } },
      { returnDocument: 'after' },
    );
    if (!updated) throw new HttpError(404, 'device_not_found');
    await store.c.sessions.updateMany({ deviceId: id }, { $set: { revoked: true } });
    await store.c.envelopes.deleteOne({ _id: id, userId: a.userId });
    res.json(toDevice(updated));
  });

  return r;
}

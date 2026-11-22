import { createPublicKey, verify } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  InitVaultRequest, PublishEnvelopesRequest, RecoverRequest,
  type EnrollmentResponse, type EnvelopeResponse, type RecoverResponse, type VaultStateResponse,
} from '@clipply/shared-schemas';

import type { Store } from '../../db';
import { HttpError, parse } from '../../errors';
import { requireAuth } from '../../middleware/auth';

const RECOVERY_WINDOW_MS = 5 * 60_000;
/** DER SubjectPublicKeyInfo prefix for a raw 32-byte Ed25519 key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(publicKeyB64: string, message: Uint8Array, signatureB64: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64, 'base64url')]), format: 'der', type: 'spki' });
    return verify(null, message, key, Buffer.from(signatureB64, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * Key distribution. The server stores sealed, signed envelopes and enforces *who may publish*,
 * but cannot read or forge them: devices verify signatures and keyring continuity themselves
 * (docs/encryption.md §5, §7). Server-side checks here are defence in depth and lockout guards.
 */
export function vaultRoutes(store: Store, now: () => number): Router {
  const r = Router();

  const user = async (userId: string) => {
    const u = await store.c.users.findOne({ _id: userId });
    if (!u) throw new HttpError(401, 'unknown_user');
    return u;
  };

  r.get('/state', async (req, res) => {
    const u = await user(requireAuth(req).userId);
    const out: VaultStateResponse = { initialized: !!u.vault, epoch: u.keyEpoch, version: u.vault?.version ?? 0 };
    res.json(out);
  });

  /** First device publishes its own envelope and the recovery envelope. Exactly once per account. */
  r.post('/init', async (req, res) => {
    const a = requireAuth(req);
    if (a.device.status !== 'authorized') throw new HttpError(403, 'device_not_authorized');
    const body = parse(InitVaultRequest, req.body);
    const u = await user(a.userId);
    if (body.envelope.deviceId !== a.deviceId || body.envelope.signerDeviceId !== a.deviceId) throw new HttpError(400, 'envelope_not_for_caller');
    if (body.envelope.epoch !== u.keyEpoch || body.recovery.epoch !== u.keyEpoch) throw new HttpError(409, 'epoch_mismatch');
    await store.tx(async (session) => {
      const claimed = await store.c.users.updateOne(
        { _id: a.userId, vault: { $exists: false } },
        { $set: { vault: { version: 1, recovery: body.recovery } } },
        { session },
      );
      if (claimed.modifiedCount !== 1) throw new HttpError(409, 'vault_exists');
      await store.c.envelopes.replaceOne(
        { _id: a.deviceId },
        { ...body.envelope, userId: a.userId, updatedAt: new Date(now()) },
        { upsert: true, session },
      );
    });
    res.status(204).end();
  });

  r.get('/envelope', async (req, res) => {
    const a = requireAuth(req);
    const env = await store.c.envelopes.findOne({ _id: a.deviceId, userId: a.userId });
    if (!env) throw new HttpError(404, 'no_envelope');
    const signer = await store.c.devices.findOne({ _id: env.signerDeviceId, userId: a.userId });
    if (!signer) throw new HttpError(404, 'signer_unknown');
    const { _id, userId, updatedAt, ...envelope } = env;
    void _id; void userId; void updatedAt;
    const out: EnvelopeResponse = { envelope, signer: { id: signer._id, name: signer.name, keys: signer.keys } };
    res.json(out);
  });

  /** An authorized device claims a pending one; both then show the enrollment code. */
  r.post('/claim/:deviceId', async (req, res) => {
    const a = requireAuth(req);
    if (a.device.status !== 'authorized') throw new HttpError(403, 'device_not_authorized');
    const id = parse(z.uuid(), req.params.deviceId);
    const updated = await store.c.devices.updateOne(
      { _id: id, userId: a.userId, status: 'pending' },
      { $set: { enrollment: { approverId: a.deviceId, at: new Date(now()) } } },
    );
    if (updated.matchedCount !== 1) throw new HttpError(404, 'pending_device_not_found');
    res.status(204).end();
  });

  r.get('/enrollment', async (req, res) => {
    const a = requireAuth(req);
    const approverId = a.device.enrollment?.approverId;
    const approver = approverId ? await store.c.devices.findOne({ _id: approverId, userId: a.userId, status: 'authorized' }) : null;
    const out: EnrollmentResponse = { approver: approver ? { id: approver._id, name: approver.name, keys: approver.keys } : null };
    res.json(out);
  });

  /**
   * Publishes envelopes signed by the caller: after approving a device (`authorize`), after a
   * recovery, or for a key rotation (`epoch` = current + 1, with a fresh recovery envelope).
   */
  r.post('/envelopes', async (req, res) => {
    const a = requireAuth(req);
    if (a.device.status !== 'authorized') throw new HttpError(403, 'device_not_authorized');
    const body = parse(PublishEnvelopesRequest, req.body);
    await store.tx(async (session) => {
      const u = await store.c.users.findOne({ _id: a.userId }, { session });
      if (!u?.vault) throw new HttpError(409, 'vault_not_initialized');
      const rotation = body.epoch === u.keyEpoch + 1;
      if (!rotation && body.epoch !== u.keyEpoch) throw new HttpError(409, 'epoch_mismatch');
      if (rotation && body.recovery?.epoch !== body.epoch) throw new HttpError(400, 'rotation_needs_recovery');
      if (body.recovery && body.recovery.epoch !== body.epoch) throw new HttpError(400, 'recovery_epoch_mismatch');
      // A new recovery key only comes with a rotation, so the old key's copy never sees new data.
      if (!rotation && body.recovery && body.recovery.signPublicKey !== u.vault.recovery.signPublicKey) {
        throw new HttpError(400, 'recovery_key_changed');
      }

      const targets = new Set(body.envelopes.map((e) => e.deviceId));
      if (targets.size !== body.envelopes.length) throw new HttpError(400, 'duplicate_envelope');
      for (const e of body.envelopes) {
        if (e.signerDeviceId !== a.deviceId || e.epoch !== body.epoch) throw new HttpError(400, 'envelope_not_signed_by_caller');
      }
      const devices = await store.c.devices.find({ _id: { $in: [...targets] }, userId: a.userId }, { session }).toArray();
      for (const id of targets) {
        const d = devices.find((x) => x._id === id);
        if (!d || d.status === 'revoked') throw new HttpError(400, 'envelope_for_unknown_device');
        if (d.status === 'pending' && id !== body.authorize) throw new HttpError(400, 'envelope_for_pending_device');
      }
      if (body.authorize) {
        const pending = devices.find((x) => x._id === body.authorize);
        if (pending?.status !== 'pending' || pending.enrollment?.approverId !== a.deviceId) throw new HttpError(403, 'not_claimed_by_caller');
      }
      if (rotation) {
        // Nobody who should keep access may be left without the new key.
        const authorized = await store.c.devices.find({ userId: a.userId, status: 'authorized' }, { session, projection: { _id: 1 } }).toArray();
        const missing = authorized.filter((d) => !targets.has(d._id));
        if (missing.length > 0) throw new HttpError(409, 'rotation_missing_devices');
      }

      const t = new Date(now());
      for (const e of body.envelopes) {
        await store.c.envelopes.replaceOne({ _id: e.deviceId }, { ...e, userId: a.userId, updatedAt: t }, { upsert: true, session });
      }
      if (body.authorize) {
        await store.c.devices.updateOne({ _id: body.authorize }, { $set: { status: 'authorized' }, $unset: { enrollment: '' } }, { session });
      }
      await store.c.users.updateOne(
        { _id: a.userId },
        { $inc: { 'vault.version': 1 }, $set: { keyEpoch: body.epoch, ...(body.recovery ? { 'vault.recovery': body.recovery } : {}) } },
        { session },
      );
    });
    res.status(204).end();
  });

  /** Recovery-key enrollment: a signature by the recovery key authorizes the calling device. */
  r.post('/recover', async (req, res) => {
    const a = requireAuth(req);
    const body = parse(RecoverRequest, req.body);
    const u = await user(a.userId);
    if (!u.vault) throw new HttpError(409, 'vault_not_initialized');
    if (Math.abs(now() - body.timestamp) > RECOVERY_WINDOW_MS) throw new HttpError(400, 'stale_proof');
    const message = new TextEncoder().encode(`clipply/v1/recover/${a.userId}/${a.deviceId}/${body.timestamp}`);
    if (!verifyEd25519(u.vault.recovery.signPublicKey, message, body.signature)) throw new HttpError(403, 'invalid_recovery_proof');
    if (a.device.status === 'pending') {
      await store.c.devices.updateOne({ _id: a.deviceId }, { $set: { status: 'authorized' }, $unset: { enrollment: '' } });
    }
    const out: RecoverResponse = { recovery: u.vault.recovery };
    res.json(out);
  });

  return r;
}

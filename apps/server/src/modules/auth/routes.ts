import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { GoogleSignInRequest, RefreshRequest, type AuthResponse, type Device } from '@clipply/shared-schemas';

import type { DeviceDoc, Store } from '../../db';
import { HttpError, parse } from '../../errors';
import type { GoogleVerifier } from './google';
import { createSession, hash, revokeSessionByToken, rotateSession, signAccessToken } from './tokens';

export function toDevice(d: DeviceDoc): Device {
  return {
    id: d._id, name: d.name, platform: d.platform, appVersion: d.appVersion, keys: d.keys, status: d.status,
    createdAt: d.createdAt.getTime(), lastSeenAt: d.lastSeenAt.getTime(),
    ...(d.lastSyncAt ? { lastSyncAt: d.lastSyncAt.getTime() } : {}),
  };
}

export interface AuthDeps {
  store: Store;
  verifyGoogle: GoogleVerifier;
  jwtSecret: string;
  now: () => number;
}

export function authRoutes(d: AuthDeps): Router {
  const r = Router();

  /**
   * Signs in with a Google ID token and registers (or re-identifies) this device. The device is
   * `pending` unless it is the account's first device; pending devices cannot touch vault data
   * until an authorized device or the recovery key enrolls them (Phase 4).
   */
  r.post('/google', async (req, res) => {
    const body = parse(GoogleSignInRequest, req.body);
    const identity = await d.verifyGoogle(body.idToken);
    if (!identity) throw new HttpError(401, 'invalid_google_token');
    const now = new Date(d.now());

    const user = await d.store.c.users.findOneAndUpdate(
      { googleSub: identity.sub },
      {
        $set: { email: identity.email },
        $setOnInsert: { _id: randomUUID(), googleSub: identity.sub, seq: 0, keyEpoch: 1, purgeFloor: 0, createdAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
    if (!user) throw new HttpError(500, 'internal');

    let device = await d.store.c.devices.findOne({ _id: body.device.id });
    if (device && device.userId !== user._id) throw new HttpError(409, 'device_id_taken');
    if (device && device.status === 'revoked') throw new HttpError(403, 'device_revoked');
    if (device && (device.keys.boxPublicKey !== body.device.keys.boxPublicKey || device.keys.signPublicKey !== body.device.keys.signPublicKey)) {
      // Same id, different keys: a reinstall must register as a new device.
      throw new HttpError(409, 'device_keys_mismatch');
    }
    if (device) {
      await d.store.c.devices.updateOne({ _id: device._id }, { $set: { appVersion: body.device.appVersion, lastSeenAt: now } });
      device = { ...device, appVersion: body.device.appVersion, lastSeenAt: now };
    } else {
      const hasAuthorized = (await d.store.c.devices.countDocuments({ userId: user._id, status: 'authorized' }, { limit: 1 })) > 0;
      device = {
        _id: body.device.id, userId: user._id, name: body.device.name, platform: body.device.platform,
        appVersion: body.device.appVersion, keys: body.device.keys, status: hasAuthorized ? 'pending' : 'authorized',
        createdAt: now, lastSeenAt: now,
      };
      await d.store.c.devices.insertOne(device);
    }

    const session = await createSession(d.store, user._id, device._id, d.now());
    const access = await signAccessToken(d.jwtSecret, { userId: user._id, deviceId: device._id, sessionId: session.sessionId }, d.now());
    const out: AuthResponse = {
      accessToken: access.token, accessExpiresAt: access.expiresAt, refreshToken: session.refreshToken,
      user: { id: user._id, email: user.email }, device: toDevice(device),
    };
    res.json(out);
  });

  r.post('/refresh', async (req, res) => {
    const { refreshToken } = parse(RefreshRequest, req.body);
    const rotated = await rotateSession(d.store, refreshToken, d.now());
    if (!rotated.ok) {
      // Tell a removed device it was removed, rather than "sign in again".
      const old = await d.store.c.sessions.findOne({ tokenHash: hash(refreshToken) });
      const dev = old && (await d.store.c.devices.findOne({ _id: old.deviceId, userId: old.userId }));
      if (dev?.status === 'revoked') throw new HttpError(403, 'device_revoked');
      throw new HttpError(401, 'invalid_refresh_token');
    }
    const device = await d.store.c.devices.findOne({ _id: rotated.deviceId, userId: rotated.userId });
    if (!device || device.status === 'revoked') throw new HttpError(403, 'device_revoked');
    const user = await d.store.c.users.findOne({ _id: rotated.userId });
    if (!user) throw new HttpError(401, 'invalid_refresh_token');
    await d.store.c.devices.updateOne({ _id: device._id }, { $set: { lastSeenAt: new Date(d.now()) } });
    const access = await signAccessToken(d.jwtSecret, { userId: rotated.userId, deviceId: rotated.deviceId, sessionId: rotated.sessionId }, d.now());
    const out: AuthResponse = {
      accessToken: access.token, accessExpiresAt: access.expiresAt, refreshToken: rotated.refreshToken,
      user: { id: user._id, email: user.email }, device: toDevice(device),
    };
    res.json(out);
  });

  r.post('/logout', async (req, res) => {
    const { refreshToken } = parse(RefreshRequest, req.body);
    await revokeSessionByToken(d.store, refreshToken);
    res.status(204).end();
  });

  return r;
}

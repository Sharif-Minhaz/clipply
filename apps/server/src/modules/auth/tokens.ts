import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';

import type { Store } from '../../db';

export const ACCESS_TTL_MS = 15 * 60_000;
export const REFRESH_TTL_MS = 90 * 86_400_000;

export interface AccessClaims {
  userId: string;
  deviceId: string;
  sessionId: string;
}

const key = (secret: string): Uint8Array => new TextEncoder().encode(secret);

export async function signAccessToken(secret: string, c: AccessClaims, now: number): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = now + ACCESS_TTL_MS;
  const token = await new SignJWT({ did: c.deviceId, sid: c.sessionId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(c.userId)
    .setIssuedAt(Math.floor(now / 1000))
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .setAudience('clipply-api')
    .sign(key(secret));
  return { token, expiresAt };
}

export async function verifyAccessToken(secret: string, token: string, now: number): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), {
      algorithms: ['HS256'],
      audience: 'clipply-api',
      currentDate: new Date(now),
    });
    if (typeof payload.sub !== 'string' || typeof payload.did !== 'string' || typeof payload.sid !== 'string') return null;
    return { userId: payload.sub, deviceId: payload.did, sessionId: payload.sid };
  } catch {
    return null;
  }
}

/** Refresh tokens are 256-bit random; only their SHA-256 is stored. */
export const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');

export async function createSession(store: Store, userId: string, deviceId: string, now: number): Promise<{ sessionId: string; refreshToken: string }> {
  const refreshToken = newToken();
  const sessionId = randomUUID();
  await store.c.sessions.insertOne({
    _id: sessionId, userId, deviceId, tokenHash: hash(refreshToken), previousHash: null, revoked: false,
    expiresAt: new Date(now + REFRESH_TTL_MS), createdAt: new Date(now),
  });
  return { sessionId, refreshToken };
}

export type RotateResult = { ok: true; sessionId: string; userId: string; deviceId: string; refreshToken: string } | { ok: false };

/**
 * Rotates a refresh token. Presenting an already-rotated token means two parties hold it, so the
 * whole session is revoked (OAuth 2.0 Security BCP refresh-token reuse detection).
 */
export async function rotateSession(store: Store, refreshToken: string, now: number): Promise<RotateResult> {
  const h = hash(refreshToken);
  const next = newToken();
  const updated = await store.c.sessions.findOneAndUpdate(
    { tokenHash: h, revoked: false, expiresAt: { $gt: new Date(now) } },
    { $set: { tokenHash: hash(next), previousHash: h, expiresAt: new Date(now + REFRESH_TTL_MS) } },
    { returnDocument: 'after' },
  );
  if (updated) return { ok: true, sessionId: updated._id, userId: updated.userId, deviceId: updated.deviceId, refreshToken: next };
  await store.c.sessions.updateOne({ previousHash: h }, { $set: { revoked: true } });
  return { ok: false };
}

export async function revokeSessionByToken(store: Store, refreshToken: string): Promise<void> {
  await store.c.sessions.updateOne({ tokenHash: hash(refreshToken) }, { $set: { revoked: true } });
}

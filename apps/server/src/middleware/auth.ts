import type { NextFunction, Request, Response } from 'express';

import type { DeviceDoc, Store } from '../db';
import { HttpError } from '../errors';
import { verifyAccessToken } from '../modules/auth/tokens';

export interface AuthContext {
  userId: string;
  deviceId: string;
  sessionId: string;
  device: DeviceDoc;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export function auth(store: Store, secret: string, now: () => number) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'unauthenticated');
    const claims = await verifyAccessToken(secret, header.slice(7), now());
    if (!claims) throw new HttpError(401, 'invalid_token');
    // Checked on every request so a revoked device loses access immediately, not at token expiry.
    const device = await store.c.devices.findOne({ _id: claims.deviceId, userId: claims.userId });
    if (!device || device.status === 'revoked') throw new HttpError(403, 'device_revoked');
    req.auth = { ...claims, device };
    next();
  };
}

/** Vault data (items, blobs) is only for devices that hold the vault key. */
export function requireAuthorizedDevice(req: Request, _res: Response, next: NextFunction): void {
  if (req.auth?.device.status !== 'authorized') throw new HttpError(403, 'device_not_authorized');
  next();
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw new HttpError(401, 'unauthenticated');
  return req.auth;
}

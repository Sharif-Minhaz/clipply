import type { NextFunction, Request, Response } from 'express';

import type { Store } from '../db';
import { HttpError } from '../errors';

/** Client address as Vercel reports it (its edge sets x-forwarded-for / x-real-ip). */
export function clientIp(req: Request): string {
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real;
  const fwd = req.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || req.socket.remoteAddress || 'unknown';
}

/**
 * Fixed-window limiter stored in MongoDB, because serverless instances share no memory.
 * Keyed by user when authenticated, otherwise by IP. Expired windows vanish via a TTL index.
 */
export function rateLimit(store: Store, name: string, limit: number, windowSec: number, now: () => number) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const t = now();
    const window = Math.floor(t / 1000 / windowSec);
    const who = req.auth?.userId ?? `ip:${clientIp(req)}`;
    const doc = await store.c.rateLimits.findOneAndUpdate(
      { _id: `${name}:${who}:${window}` },
      { $inc: { n: 1 }, $setOnInsert: { expiresAt: new Date((window + 1) * windowSec * 1000 + 60_000) } },
      { upsert: true, returnDocument: 'after' },
    );
    if ((doc?.n ?? 0) > limit) {
      res.setHeader('retry-after', String((window + 1) * windowSec - Math.floor(t / 1000)));
      throw new HttpError(429, 'rate_limited');
    }
    next();
  };
}

import type { ErrorRequestHandler } from 'express';
import type { z } from 'zod';
import type { Logger } from '@clipply/logger';

/** Errors with a stable, client-visible code. Anything else becomes a generic 500. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

export function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new HttpError(400, 'invalid_request');
  return r.data;
}

/** Never echoes request data, stack traces or internal messages to the client or the logs. */
export function errorHandler(log: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.code });
      return;
    }
    const status = (err as { status?: number; type?: string }).status;
    if (status === 413) {
      res.status(413).json({ error: 'payload_too_large' });
      return;
    }
    if (status === 400 && (err as { type?: string }).type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json' });
      return;
    }
    log.error('unhandled error', { error: err, method: req.method, route: req.route?.path ?? req.path });
    res.status(500).json({ error: 'internal' });
  };
}

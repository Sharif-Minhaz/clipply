import type { z } from 'zod';
import { PullResponse, PushResponse, SyncHead, type PushRequest } from '@clipply/shared-schemas';

export type ApiErrorKind =
  | 'network' | 'timeout' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'gone' | 'invalid_request' | 'rate_limited' | 'server' | 'bad_response';

/** Error messages carry status and server error code only, never request or response bodies. */
export class ApiError extends Error {
  override name = 'ApiError';

  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }

  /** Worth retrying later with backoff. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'timeout' || this.kind === 'server' || this.kind === 'rate_limited';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  /** Current access token, or null when signed out. */
  getAccessToken: () => Promise<string | null>;
  /** Called once on 401; resolves true if a new access token is now available. */
  refreshSession?: () => Promise<boolean>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const STATUS_KIND: Record<number, ApiErrorKind> = {
  400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found',
  409: 'conflict', 410: 'gone', 413: 'invalid_request', 422: 'invalid_request', 429: 'rate_limited',
};

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  async function send(method: string, path: string, body: unknown): Promise<Response> {
    const token = await options.getAccessToken();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    try {
      return await doFetch(`${base}${path}`, {
        method,
        headers,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'TimeoutError' || name === 'AbortError') throw new ApiError('timeout', `${method} ${path} timed out`);
      throw new ApiError('network', `${method} ${path} failed: network error`);
    }
  }

  async function request<S extends z.ZodType>(method: string, path: string, schema: S, body?: unknown): Promise<z.infer<S>> {
    let res = await send(method, path, body);
    if (res.status === 401 && options.refreshSession && (await options.refreshSession())) {
      res = await send(method, path, body);
    }
    if (!res.ok) {
      let code = '';
      try {
        const err = (await res.json()) as { error?: unknown };
        if (typeof err.error === 'string') code = `: ${err.error.slice(0, 80)}`;
      } catch {
        // Non-JSON error bodies are expected from proxies; the status alone classifies them.
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      throw new ApiError(
        STATUS_KIND[res.status] ?? (res.status >= 500 ? 'server' : 'invalid_request'),
        `${method} ${path} → ${res.status}${code}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      );
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiError('bad_response', `${method} ${path}: response is not JSON`, res.status);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new ApiError('bad_response', `${method} ${path}: response failed validation`, res.status);
    return parsed.data;
  }

  return {
    syncHead: () => request('GET', '/v1/sync/head', SyncHead),
    pull: (cursor: number, limit = 200) =>
      request('GET', `/v1/sync/pull?cursor=${encodeURIComponent(cursor)}&limit=${encodeURIComponent(limit)}`, PullResponse),
    push: (body: PushRequest) => request('POST', '/v1/sync/push', PushResponse, body),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

import { describe, expect, it, vi } from 'vitest';

import { ApiError, createApiClient } from './client';

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function setup(responses: Array<Response | Error>, opts: { token?: string | null; refresh?: () => Promise<boolean> } = {}) {
  const fetch = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const client = createApiClient({
    baseUrl: 'https://api.test/',
    getAccessToken: async () => (opts.token === undefined ? 'tok' : opts.token),
    ...(opts.refresh ? { refreshSession: opts.refresh } : {}),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });
  return { client, fetch };
}

describe('api client', () => {
  it('sends the bearer token and validates the response', async () => {
    const { client, fetch } = setup([json(200, { seq: 4, keyEpoch: 1 })]);
    expect(await client.syncHead()).toEqual({ seq: 4, keyEpoch: 1, features: [] });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.test/v1/sync/head');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('omits authorization when signed out and sends JSON bodies', async () => {
    const { client, fetch } = setup([json(200, { results: [] })], { token: null });
    await client.push({ ops: [{ type: 'delete', opId: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b', itemId: '0193a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' }] });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty('authorization');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string).ops).toHaveLength(1);
  });

  it('rejects responses that do not match the schema', async () => {
    const { client } = setup([json(200, { seq: -1, keyEpoch: 1 })]);
    await expect(client.syncHead()).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('refreshes once on 401 and retries', async () => {
    const refresh = vi.fn(async () => true);
    const { client, fetch } = setup([json(401, { error: 'expired' }), json(200, { seq: 1, keyEpoch: 1 })], { refresh });
    expect(await client.syncHead()).toEqual({ seq: 1, keyEpoch: 1, features: [] });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('classifies failures and marks which ones are retryable', async () => {
    const cases: Array<[Response | Error, string, boolean]> = [
      [new TypeError('fetch failed'), 'network', true],
      [Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout', true],
      [json(410, { error: 'cursor_expired' }), 'gone', false],
      [json(429, {}, { 'retry-after': '30' }), 'rate_limited', true],
      [new Response('<html>bad gateway</html>', { status: 502 }), 'server', true],
      [json(403, { error: 'device_revoked' }), 'forbidden', false],
    ];
    for (const [res, kind, retryable] of cases) {
      const { client } = setup([res]);
      const err = (await client.pull(0).catch((e: unknown) => e)) as ApiError;
      expect(err).toBeInstanceOf(ApiError);
      expect([err.kind, err.retryable]).toEqual([kind, retryable]);
      if (kind === 'rate_limited') expect(err.retryAfterMs).toBe(30_000);
      if (kind === 'gone') expect(err.message).toContain('cursor_expired');
    }
  });
});

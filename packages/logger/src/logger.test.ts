import { describe, expect, it } from 'vitest';

import { createLogger, type LogRecord } from './index';

describe('logger', () => {
  it('never lets clipboard content or key material reach the sink', () => {
    const records: LogRecord[] = [];
    const log = createLogger('sync', { sink: (r) => records.push(r) });
    const secret = 'PLAINTEXT-SECRET';
    log.info('pushed', {
      itemId: 'abc',
      count: 3,
      body: secret,
      item: { meta: { title: secret }, dek: Uint8Array.of(1), nested: { text: secret } },
      headers: { authorization: `Bearer ${secret}` },
      list: [{ content: secret }],
      raw: Uint8Array.of(1, 2, 3),
      err: new Error('boom'),
    });
    const out = JSON.stringify(records);
    expect(out).not.toContain(secret);
    expect(records[0]?.fields).toMatchObject({ itemId: 'abc', count: 3, body: '[redacted]', raw: '[3 bytes]', err: { message: 'boom' } });
  });

  it('filters by level and scopes children', () => {
    const records: LogRecord[] = [];
    const log = createLogger('app', { sink: (r) => records.push(r), level: 'warn' });
    log.info('hidden');
    log.child('db').warn('shown');
    expect(records.map((r) => [r.scope, r.message])).toEqual([['app:db', 'shown']]);
  });
});

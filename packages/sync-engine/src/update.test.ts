// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { AUTO_CHECK_INTERVAL, compareVersions, parseLatestRelease, RELEASES_PAGE, UpdateChecker } from './update';

describe('versions', () => {
  it('compares numerically, with or without a v prefix', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('v1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareVersions('0.1.1', 'v0.1.1')).toBe(0);
    expect(compareVersions('0.1.1', '0.2.0')).toBeLessThan(0);
  });

  it('reads only published, plain x.y.z releases', () => {
    expect(parseLatestRelease({ tag_name: 'v0.2.0', draft: false, prerelease: false })).toBe('0.2.0');
    expect(parseLatestRelease({ tag_name: 'v0.2.0', prerelease: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v0.2.0', draft: true })).toBeNull();
    expect(parseLatestRelease({ tag_name: 'v0.2.0-beta.1' })).toBeNull();
    expect(parseLatestRelease({ message: 'Not Found' })).toBeNull();
  });
});

function setup(responses: unknown[]) {
  let t = 1_000_000;
  let stored: { latest: string; checkedAt: number } | undefined;
  let calls = 0;
  const checker = new UpdateChecker({
    currentVersion: '0.1.1',
    fetchLatest: async () => {
      calls++;
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return r;
    },
    store: { get: async () => stored, set: async (v) => void (stored = v) },
    now: () => t,
  });
  return { checker, calls: () => calls, advance: (ms: number) => void (t += ms), stored: () => stored };
}

describe('UpdateChecker', () => {
  it('reports a newer release with a link built from its tag', async () => {
    const s = setup([{ tag_name: 'v0.2.0' }]);
    expect((await s.checker.state()).available).toBe(false);
    const state = await s.checker.check();
    expect(state).toMatchObject({ current: '0.1.1', latest: '0.2.0', available: true, url: `${RELEASES_PAGE}/tag/v0.2.0` });
  });

  it('is not available when the latest release is this version or older', async () => {
    const s = setup([{ tag_name: 'v0.1.1' }]);
    expect(await s.checker.check()).toMatchObject({ available: false, url: RELEASES_PAGE });
  });

  it('checks automatically at most once per interval, but always when forced', async () => {
    const s = setup([{ tag_name: 'v0.1.1' }, { tag_name: 'v0.1.2' }, { tag_name: 'v0.1.3' }]);
    await s.checker.check();
    await s.checker.check();
    expect(s.calls()).toBe(1);
    expect((await s.checker.check({ force: true })).latest).toBe('0.1.2');
    s.advance(AUTO_CHECK_INTERVAL);
    expect((await s.checker.check()).latest).toBe('0.1.3');
    expect(s.calls()).toBe(3);
  });

  it('keeps the previous result when a check fails', async () => {
    const s = setup([{ tag_name: 'v0.2.0' }, new Error('offline')]);
    await s.checker.check();
    await expect(s.checker.check({ force: true })).rejects.toThrow('offline');
    expect(await s.checker.state()).toMatchObject({ latest: '0.2.0', available: true });
  });

  it('rejects a response without a usable version', async () => {
    const s = setup([{ message: 'API rate limit exceeded' }]);
    await expect(s.checker.check()).rejects.toThrow(/release version/);
    expect(s.stored()).toBeUndefined();
  });
});

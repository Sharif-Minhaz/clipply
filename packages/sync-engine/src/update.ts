import { z } from 'zod';

/**
 * "Is there a newer release?" — check only, never download or install. GitHub Releases is the
 * only distribution channel, so the one request is an anonymous GET to GitHub's public API: no
 * ids, no account, nothing about the user's clips. The link shown is built from the version tag,
 * never taken from the response, so it can only point at this project's release page.
 */
export const RELEASES_API = 'https://api.github.com/repos/Sharif-Minhaz/clipply/releases/latest';
export const RELEASES_PAGE = 'https://github.com/Sharif-Minhaz/clipply/releases';

/** Automatic checks happen on app open / window focus, at most this often. */
export const AUTO_CHECK_INTERVAL = 24 * 3_600_000;

const SEMVER = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;

export function parseVersion(v: string): [number, number, number] | null {
  const m = SEMVER.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Negative when a < b, 0 when equal, positive when a > b. Unparseable versions count as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a) ?? [0, 0, 0];
  const y = parseVersion(b) ?? [0, 0, 0];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
}

const LatestRelease = z.object({
  tag_name: z.string().max(64),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

/** Version from GitHub's `releases/latest` response; null for drafts, pre-releases or odd tags. */
export function parseLatestRelease(json: unknown): string | null {
  const r = LatestRelease.safeParse(json);
  if (!r.success || r.data.draft || r.data.prerelease) return null;
  const v = parseVersion(r.data.tag_name);
  return v ? v.join('.') : null;
}

export interface UpdateState {
  current: string;
  /** Newest published version seen by the last successful check; null before any check. */
  latest: string | null;
  available: boolean;
  /** Release page for `latest`, or the releases list. */
  url: string;
  checkedAt: number | null;
}

interface Stored {
  latest: string;
  checkedAt: number;
}

export interface UpdateCheckerDeps {
  currentVersion: string;
  /** GET RELEASES_API and return the parsed JSON body; throw on network / HTTP errors. */
  fetchLatest: () => Promise<unknown>;
  /** Persists the last result so the notice survives a restart without a new request. */
  store: { get(): Promise<Stored | undefined>; set(v: Stored): Promise<void> };
  now?: () => number;
}

export class UpdateChecker {
  private last: Stored | undefined;
  private loaded = false;
  private inflight: Promise<UpdateState> | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: UpdateCheckerDeps) {
    this.now = deps.now ?? Date.now;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.last = await this.deps.store.get();
    this.loaded = true;
  }

  private toState(): UpdateState {
    const latest = this.last?.latest ?? null;
    const available = latest !== null && compareVersions(latest, this.deps.currentVersion) > 0;
    return {
      current: this.deps.currentVersion,
      latest,
      available,
      url: available ? `${RELEASES_PAGE}/tag/v${latest}` : RELEASES_PAGE,
      checkedAt: this.last?.checkedAt ?? null,
    };
  }

  /** Last known result, without a network request. */
  async state(): Promise<UpdateState> {
    await this.load();
    return this.toState();
  }

  /**
   * Asks GitHub for the latest release. Without `force`, does nothing if the last check was less
   * than AUTO_CHECK_INTERVAL ago. Errors propagate (manual checks show them; automatic ones ignore them).
   */
  async check({ force = false } = {}): Promise<UpdateState> {
    await this.load();
    if (!force && this.last && this.now() - this.last.checkedAt < AUTO_CHECK_INTERVAL) return this.toState();
    this.inflight ??= (async () => {
      try {
        const latest = parseLatestRelease(await this.deps.fetchLatest());
        if (!latest) throw new Error('GitHub did not return a release version');
        this.last = { latest, checkedAt: this.now() };
        await this.deps.store.set(this.last);
        return this.toState();
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

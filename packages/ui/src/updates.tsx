import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { UpdateState } from '@clipply/sync-engine';

import { buttonClass, SwitchRow } from './settings';
import { formatRelative } from './time';

/** Platform side of updates. Only `install` downloads anything, and only when the user asks. */
export interface UpdateClient {
  /** Last known result, no network. */
  state(): Promise<UpdateState>;
  /** Asks GitHub now (manual "Check for updates"). */
  check(): Promise<UpdateState>;
  /** Opens the release page in the system browser. */
  openReleasePage(): Promise<void>;
  /**
   * Downloads the newest release and installs it (desktop restarts into it; Android opens the system
   * installer). Absent where the app cannot update itself; the release page is the fallback.
   */
  install?(onProgress?: (percent: number) => void): Promise<void>;
  /** Fires when an automatic check finishes. */
  onChange(cb: () => void): () => void;
}

export function useUpdateState(client: UpdateClient): [UpdateState | null, (s: UpdateState) => void] {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let live = true;
    const load = (): void => void client.state().then((s) => live && setState(s), () => {});
    load();
    const off = client.onChange(load);
    return () => {
      live = false;
      off();
    };
  }, [client]);
  return [state, setState];
}

/**
 * Runs `install` (or opens the release page without it). `percent` is the download progress (null
 * until known), `label` the matching busy text, `error` explains the last failed attempt.
 */
function useInstall(client: UpdateClient): { busy: boolean; percent: number | null; label: string; error: string | null; run: () => void } {
  const [busy, setBusy] = useState(false);
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = (): void => {
    if (!client.install) return void client.openReleasePage();
    setBusy(true);
    setPercent(null);
    setError(null);
    client.install((p) => setPercent(Math.min(100, Math.max(0, Math.round(p))))).then(
      () => setBusy(false),
      (e: unknown) => {
        setBusy(false);
        setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '') : String(e));
      },
    );
  };
  const label = percent === null ? 'Downloading…' : percent >= 100 ? 'Installing…' : `Downloading ${percent}%`;
  return { busy, percent, label, error, run };
}

function ProgressBar({ percent }: { percent: number }) {
  return (
    <span role="progressbar" aria-label="Download progress" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} className="mt-1.5 block h-1 overflow-hidden rounded-full bg-clip/20">
      <span className="block h-full rounded-full bg-clip transition-[width]" style={{ width: `${percent}%` }} />
    </span>
  );
}

/** The installed version as `v1.2.3` (no network); renders nothing until it is known. */
export function AppVersion({ client, className }: { client: UpdateClient; className?: string }) {
  const [state] = useUpdateState(client);
  if (!state) return null;
  return <span className={className}>v{state.current}</span>;
}

/** Settings section body: current version, manual check, download link and the auto-check switch. */
export function UpdatePanel({ client, autoCheck, onAutoCheck }: { client: UpdateClient; autoCheck: boolean; onAutoCheck: (on: boolean) => void }) {
  const [state, setState] = useUpdateState(client);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);
  const install = useInstall(client);

  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      setState(await client.check());
      setJustChecked(true);
    } catch {
      setError('Could not check GitHub for updates. Check your connection and try again later.');
    } finally {
      setChecking(false);
    }
  }, [client, setState]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-ink">
          Clipply {state?.current ?? '…'}
          <span role="status" className="mt-0.5 block text-xs text-muted">
            {error ??
              install.error ??
              (state?.available
                ? `Version ${state.latest} is available.`
                : state?.checkedAt
                  ? `${justChecked ? 'You have the latest version.' : 'Up to date'} · checked ${formatRelative(state.checkedAt, Date.now())}`
                  : 'Not checked yet.')}
          </span>
        </span>
        <span className="flex flex-wrap gap-2">
          {state?.available && (
            <button type="button" onClick={install.run} disabled={install.busy} className={buttonClass.primary}>
              <Download aria-hidden className={`size-4 ${install.busy ? 'animate-pulse' : ''}`} />{' '}
              {install.busy ? install.label : client.install ? `Update to ${state.latest}` : `Download ${state.latest}`}
            </button>
          )}
          {state?.available && install.error && (
            <button type="button" onClick={() => void client.openReleasePage()} className={buttonClass.plain}>
              Release page
            </button>
          )}
          <button type="button" onClick={() => void check()} disabled={checking} className={buttonClass.plain}>
            <RefreshCw aria-hidden className={`size-4 ${checking ? 'animate-spin' : ''}`} /> {checking ? 'Checking…' : 'Check for updates'}
          </button>
        </span>
      </div>
      <SwitchRow
        label="Check for updates automatically"
        hint="At most once a day, when Clipply opens. Sends one anonymous request to GitHub (it sees your IP address); nothing about you or your clips."
        checked={autoCheck}
        onChange={onAutoCheck}
      />
    </>
  );
}

/** Shown only when a newer version is known: a sidebar item (desktop) or a banner (Android). */
export function UpdateNotice({ client, variant }: { client: UpdateClient; variant: 'sidebar' | 'banner' }) {
  const [state] = useUpdateState(client);
  const install = useInstall(client);
  if (!state?.available) return null;
  const selfUpdate = !!client.install;
  const hint = install.busy ? install.label : install.error ? `${install.error} Tap to try again.` : selfUpdate ? 'Tap to update.' : 'Tap to open the download page.';
  if (variant === 'sidebar') {
    return (
      <button
        type="button"
        onClick={install.run}
        disabled={install.busy}
        title={install.error ?? (selfUpdate ? `Download and install Clipply ${state.latest}` : `Open the Clipply ${state.latest} release page`)}
        className="flex w-full items-center gap-2.5 rounded-lg bg-clip/15 px-3 py-2 text-left text-xs font-semibold text-frame-ink hover:bg-clip/25"
      >
        <Download aria-hidden className={`size-4 shrink-0 text-clip ${install.busy ? 'animate-pulse' : ''}`} />
        <span className="flex-1">
          {install.busy ? install.label : `Update available: ${state.latest}`}
          {install.busy && install.percent !== null && <ProgressBar percent={install.percent} />}
        </span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={install.run}
      disabled={install.busy}
      className="flex w-full items-center gap-3 rounded-xl border border-clip/40 bg-clip/10 px-4 py-3 text-left text-sm text-ink"
    >
      <Download aria-hidden className={`size-5 shrink-0 text-clip ${install.busy ? 'animate-pulse' : ''}`} />
      <span className="flex-1">
        <span className="font-semibold">Clipply {state.latest} is available</span>
        <span role="status" className={`block text-xs ${install.error ? 'text-danger' : 'text-muted'}`}>{hint}</span>
        {install.busy && install.percent !== null && <ProgressBar percent={install.percent} />}
      </span>
    </button>
  );
}

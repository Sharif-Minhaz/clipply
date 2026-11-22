import { useCallback, useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import type { UpdateState } from '@clipply/sync-engine';

import { buttonClass, SwitchRow } from './settings';
import { formatRelative } from './time';

/** Platform side of update checks. Nothing here downloads or installs anything. */
export interface UpdateClient {
  /** Last known result, no network. */
  state(): Promise<UpdateState>;
  /** Asks GitHub now (manual "Check for updates"). */
  check(): Promise<UpdateState>;
  /** Opens the release page in the system browser. */
  openReleasePage(): Promise<void>;
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

/** Settings section body: current version, manual check, download link and the auto-check switch. */
export function UpdatePanel({ client, autoCheck, onAutoCheck }: { client: UpdateClient; autoCheck: boolean; onAutoCheck: (on: boolean) => void }) {
  const [state, setState] = useUpdateState(client);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justChecked, setJustChecked] = useState(false);

  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    setError(null);
    try {
      setState(await client.check());
      setJustChecked(true);
    } catch {
      setError('Could not reach GitHub. Check your connection and try again.');
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
              (state?.available
                ? `Version ${state.latest} is available.`
                : state?.checkedAt
                  ? `${justChecked ? 'You have the latest version.' : 'Up to date'} · checked ${formatRelative(state.checkedAt, Date.now())}`
                  : 'Not checked yet.')}
          </span>
        </span>
        <span className="flex flex-wrap gap-2">
          {state?.available && (
            <button type="button" onClick={() => void client.openReleasePage()} className={buttonClass.primary}>
              <Download aria-hidden className="size-4" /> Download {state.latest}
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
  if (!state?.available) return null;
  const open = (): void => void client.openReleasePage();
  if (variant === 'sidebar') {
    return (
      <button
        type="button"
        onClick={open}
        title={`Open the Clipply ${state.latest} release page`}
        className="flex w-full items-center gap-2.5 rounded-lg bg-clip/15 px-3 py-2 text-left text-xs font-semibold text-frame-ink hover:bg-clip/25"
      >
        <Download aria-hidden className="size-4 shrink-0 text-clip" />
        <span className="flex-1">Update available: {state.latest}</span>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={open}
      className="flex w-full items-center gap-3 rounded-xl border border-clip/40 bg-clip/10 px-4 py-3 text-left text-sm text-ink"
    >
      <Download aria-hidden className="size-5 shrink-0 text-clip" />
      <span className="flex-1">
        <span className="font-semibold">Clipply {state.latest} is available</span>
        <span className="block text-xs text-muted">Tap to open the download page.</span>
      </span>
    </button>
  );
}

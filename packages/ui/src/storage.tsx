import { useEffect, useState } from 'react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { StorageStats } from '@clipply/sync-engine';

import { useClipply } from './client';
import { buttonClass } from './settings';
import { formatBytes } from './viewer';

const LABEL: Record<ClipKind, string> = { text: 'Text', url: 'Links', html: 'Rich text', code: 'Code', image: 'Images', file: 'Files' };

/** Local history usage by kind, with clearing (pinned and favorite items are always kept). */
export function StoragePanel() {
  const client = useClipply();
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const load = (): void => void client.storage().then(setStats, () => {});
    load();
    return client.subscribe(load);
  }, [client]);

  const clear = (kinds: ClipKind[] | undefined, what: string): void => {
    if (!window.confirm(`Delete ${what}, except pinned and favorite items? This also removes them from your other devices and cannot be undone.`)) return;
    setNote(null);
    client.clear(kinds).then((n) => setNote(`Deleted ${n} item${n === 1 ? '' : 's'}.`), (e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
  };

  if (!stats) return null;
  const kinds = (Object.keys(stats.byKind) as ClipKind[]).sort((a, b) => stats.byKind[b]!.bytes - stats.byKind[a]!.bytes);
  return (
    <div className="space-y-2 text-sm">
      <p>
        <span className="font-semibold">{stats.count} clip{stats.count === 1 ? '' : 's'}</span>, {formatBytes(stats.bytes)} on this device
        {stats.kept > 0 && <span className="text-muted">. {stats.kept} pinned or favorite.</span>}
      </p>
      <ul className="space-y-1">
        {kinds.map((k) => (
          <li key={k} className="flex items-center gap-2">
            <span className="flex-1">{LABEL[k]}</span>
            <span className="text-sm text-muted tabular-nums">{stats.byKind[k]!.count} clips, {formatBytes(stats.byKind[k]!.bytes)}</span>
            <button type="button" aria-label={`Clear ${LABEL[k]}`} onClick={() => clear([k], `all ${LABEL[k].toLowerCase()}`)} className="rounded-md px-2 py-0.5 text-sm text-danger hover:bg-danger/10">
              Clear
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={stats.count === stats.kept}
        onClick={() => clear(undefined, 'all history')}
        className={buttonClass.danger}
      >
        Clear history
      </button>
      {note && <p role="status" className="text-xs text-muted">{note}</p>}
    </div>
  );
}

export interface BackupActions {
  /** Asks for a destination, writes the encrypted file; null when cancelled. */
  exportBackup(passphrase: string): Promise<{ count: number; skipped: number } | null>;
  /** Asks for a file and imports it; null when cancelled. */
  importBackup(passphrase: string): Promise<{ imported: number; duplicates: number; failed: number } | null>;
}

const MIN_PASSPHRASE = 10;

/** Passphrase-encrypted export/import. The file can be moved anywhere: without the passphrase it is unreadable. */
export function BackupPanel({ actions }: { actions: BackupActions }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const run = (fn: () => Promise<string | null>): void => {
    setBusy(true);
    setNote(null);
    fn().then((m) => {
      if (m) setNote(m);
      setPassphrase('');
      setConfirm('');
    }, (e: unknown) => setNote(e instanceof Error ? e.message.replace(/^\w*Error: /, '') : String(e))).finally(() => setBusy(false));
  };
  const long = passphrase.length >= MIN_PASSPHRASE;
  const input = 'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm';

  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-muted">
        Backups are encrypted with a passphrase you choose (at least {MIN_PASSPHRASE} characters). Clipply cannot open a backup without it.
      </p>
      <input type="password" aria-label="Backup passphrase" placeholder="Passphrase" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} className={input} />
      <input type="password" aria-label="Repeat passphrase (export only)" placeholder="Repeat passphrase to export" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || !long || confirm !== passphrase}
          onClick={() => run(async () => {
            const r = await actions.exportBackup(passphrase);
            return r && `Exported ${r.count} items${r.skipped ? ` (${r.skipped} not available offline were skipped)` : ''}.`;
          })}
          className={buttonClass.plain}
        >
          Export…
        </button>
        <button
          type="button"
          disabled={busy || !long}
          onClick={() => run(async () => {
            const r = await actions.importBackup(passphrase);
            return r && `Imported ${r.imported} items; ${r.duplicates} were already here${r.failed ? `; ${r.failed} could not be read` : ''}.`;
          })}
          className={buttonClass.plain}
        >
          Import…
        </button>
      </div>
      {busy && <p className="text-xs text-muted">Working… (deriving the key takes a moment)</p>}
      {note && <p role="status" className="text-xs text-muted">{note}</p>}
    </div>
  );
}

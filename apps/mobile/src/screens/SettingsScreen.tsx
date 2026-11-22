import { useState, type ReactNode } from 'react';
import { BackupPanel, StoragePanel } from '@clipply/ui';

import type { MobileSettings, Runtime } from '../services/runtime';

const RETENTION = [1, 7, 30, 90, 365, 0];

export function SettingsScreen({ rt }: { rt: Runtime }) {
  const [s, setS] = useState<MobileSettings>(rt.settings());
  const [note, setNote] = useState<string | null>(null);
  const update = (patch: Partial<MobileSettings>): void => {
    rt.updateSettings(patch).then((next) => {
      setS(next);
      if (patch.screenshots && !next.screenshots) setNote('Photo access was not granted, so screenshots cannot be imported.');
    }, (e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
  };

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-lg font-semibold">Settings</h1>
      <Section title="Capture">
        <Toggle label="Capture monitoring" hint="Off pauses every capture path, including the screenshot job." checked={s.monitoring} onChange={(v) => update({ monitoring: v })} />
        <Toggle label="Save the clipboard when I open Clipply" checked={s.captureOnOpen} onChange={(v) => update({ captureOnOpen: v })} />
        <Toggle label="Import new screenshots" hint="Needs photo access. Android wakes Clipply only when a new image appears; nothing runs in between." checked={s.screenshots} onChange={(v) => update({ screenshots: v })} />
        <p className="text-xs text-muted">
          Android only lets the app on screen read the clipboard. Clipply never reads it in the background. Other ways to save: Share → Clipply,
          select text → “Save to Clipply”, or the Clipply Quick Settings tile. Passwords marked sensitive are skipped.
        </p>
      </Section>
      <Section title="History">
        <label className="flex items-center justify-between text-sm">
          Keep history for
          <select value={s.retentionDays} onChange={(e) => update({ retentionDays: Number(e.target.value) })} className="rounded-md border border-line bg-raised px-2 py-1">
            {RETENTION.map((d) => <option key={d} value={d}>{d === 0 ? 'Forever' : `${d} day${d > 1 ? 's' : ''}`}</option>)}
          </select>
        </label>
        <StoragePanel />
      </Section>
      <Section title="Backup">
        <BackupPanel actions={rt} />
      </Section>
      <Section title="Battery">
        <p className="text-xs text-muted">
          No background service, polling or open connection. Items saved while Clipply is closed are uploaded by one batched job that waits
          for a network connection; new items from other devices arrive when you open the app.
        </p>
      </Section>
      {note && <p role="status" className="text-sm text-muted">{note}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-line bg-raised/40 p-4">
      <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h2>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-4 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-[var(--color-accent)]" />
    </label>
  );
}

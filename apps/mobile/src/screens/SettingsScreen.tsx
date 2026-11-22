import { useState } from 'react';
import { BackupPanel, SettingsSection, StoragePanel, SwitchRow, ThemeSwitcher } from '@clipply/ui';

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
    <div className="space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
      {note && <p role="status" className="rounded-lg bg-clip/15 px-4 py-3 text-sm">{note}</p>}
      <SettingsSection title="Appearance">
        <div className="space-y-2">
          <span className="text-sm">Theme</span>
          <ThemeSwitcher />
        </div>
      </SettingsSection>
      <SettingsSection
        title="Capture"
        description="Android lets only the app on screen read the clipboard, so Clipply never reads it in the background. You can also share to Clipply, use “Save to Clipply” on selected text, or the Quick Settings tile."
      >
        <SwitchRow label="Save clips" hint="Off pauses every way of saving, including screenshots." checked={s.monitoring} onChange={(v) => update({ monitoring: v })} />
        <SwitchRow label="Save the clipboard when I open Clipply" checked={s.captureOnOpen} onChange={(v) => update({ captureOnOpen: v })} />
        <SwitchRow label="Import new screenshots" hint="Needs photo access. Android wakes Clipply only when a new image appears." checked={s.screenshots} onChange={(v) => update({ screenshots: v })} />
      </SettingsSection>
      <SettingsSection title="History" description="Pinned and favorite clips are always kept.">
        <label className="flex items-center justify-between gap-4">
          <span className="text-sm">Keep clips for</span>
          <select value={s.retentionDays} onChange={(e) => update({ retentionDays: Number(e.target.value) })} className="rounded-lg border border-line bg-surface px-3 py-1.5 text-sm">
            {RETENTION.map((d) => <option key={d} value={d}>{d === 0 ? 'Forever' : d === 365 ? '1 year' : `${d} day${d > 1 ? 's' : ''}`}</option>)}
          </select>
        </label>
        <StoragePanel />
      </SettingsSection>
      <SettingsSection title="Backup" description="Save your history to an encrypted file, or bring one back in.">
        <BackupPanel actions={rt} />
      </SettingsSection>
      <SettingsSection title="Battery">
        <p className="text-sm text-muted">
          Nothing runs in the background. Clips saved while Clipply is closed upload in one batch once you are online. Clips from your other
          devices arrive when you open the app.
        </p>
      </SettingsSection>
    </div>
  );
}

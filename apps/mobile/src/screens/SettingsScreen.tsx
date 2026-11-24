import { useState } from 'react';
import { AppVersion, BackupPanel, OCR_LANGUAGES_NOTE, OcrLanguageRows, selectClass, SettingRow, SettingsSection, SimilarPanel, StoragePanel, SwitchRow, ThemeSwitcher, UpdatePanel } from '@clipply/ui';

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
    <div className="space-y-6 px-4 pt-6 pb-10">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="px-1 text-[1.75rem] leading-tight font-bold tracking-tight text-ink">Settings</h1>
        <span className="px-1 text-xs text-muted">Clipply <AppVersion client={rt.updates} className="tabular-nums" /></span>
      </header>
      {note && <p role="status" className="rounded-xl bg-clip/15 px-4 py-3 text-sm">{note}</p>}
      <SettingsSection title="Appearance">
        <SettingRow label="Theme"><ThemeSwitcher /></SettingRow>
      </SettingsSection>
      <SettingsSection
        title="Capture"
        description="Android lets only the app on screen read the clipboard, so Clipply never reads it in the background. To save from other apps, share to Clipply, use “Save to Clipply” on selected text, or the Quick Settings tile."
      >
        <SwitchRow label="Save clips" hint="Off pauses every way of saving, including screenshots." checked={s.monitoring} onChange={(v) => update({ monitoring: v })} />
        <SwitchRow label="Save the clipboard when I open Clipply" checked={s.captureOnOpen} onChange={(v) => update({ captureOnOpen: v })} />
        <SwitchRow label="Import new screenshots" hint="Needs photo access. Android wakes Clipply only when a new image appears." checked={s.screenshots} onChange={(v) => update({ screenshots: v })} />
        <SwitchRow
          label="Show link previews"
          hint="Fetches the page’s preview image. The site sees your IP address, and a one-time link (sign-in, password reset) may be used up."
          checked={s.linkPreviews}
          onChange={(v) => update({ linkPreviews: v })}
        />
      </SettingsSection>
      <SettingsSection title="History" description="Favorite clips are always kept.">
        <SettingRow label={<label htmlFor="retention">Keep clips for</label>}>
          <select id="retention" value={s.retentionDays} onChange={(e) => update({ retentionDays: Number(e.target.value) })} className={selectClass}>
            {RETENTION.map((d) => <option key={d} value={d}>{d === 0 ? 'Forever' : d === 365 ? '1 year' : `${d} day${d > 1 ? 's' : ''}`}</option>)}
          </select>
        </SettingRow>
        <StoragePanel />
        <SimilarPanel />
      </SettingsSection>
      <SettingsSection title="Text in images" description={OCR_LANGUAGES_NOTE}>
        <OcrLanguageRows value={s.ocrLanguages} onChange={(ocrLanguages) => update({ ocrLanguages })} />
      </SettingsSection>
      <SettingsSection title="Backup" description="Save your history to an encrypted file, or bring one back in.">
        <BackupPanel actions={rt} />
      </SettingsSection>
      <SettingsSection title="Updates" description="New versions are published on GitHub Releases only. Clipply tells you when one is out; you download and install it yourself.">
        <UpdatePanel client={rt.updates} autoCheck={s.checkUpdates} onAutoCheck={(v) => update({ checkUpdates: v })} />
      </SettingsSection>
      <SettingsSection title="Battery">
        <p className="text-sm leading-relaxed text-muted">
          Nothing runs in the background. Clips saved while Clipply is closed upload in one batch once you are online. Clips from your other
          devices arrive when you open the app.
        </p>
      </SettingsSection>
    </div>
  );
}

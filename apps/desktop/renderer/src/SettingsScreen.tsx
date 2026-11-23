import { useEffect, useState } from 'react';
import { AppVersion, BackupPanel, buttonClass, selectClass, SettingRow, SettingsSection, StoragePanel, SwitchRow, ThemeSwitcher, UpdatePanel } from '@clipply/ui';

import type { DesktopStatus } from '../../electron/shared/api';
import type { Settings } from '../../electron/main/settings';

const RETENTION = [
  { days: 1, label: '1 day' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Forever' },
];

const PROVIDER_LABEL: Record<string, string> = {
  'xwayland-helper': 'Background helper on XWayland',
  'electron-x11': 'X11',
};

export function SettingsScreen({ status, onChanged }: { status: DesktopStatus | null; onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.clipply.getSettings().then(setSettings);
  }, []);

  const update = async (patch: Partial<Settings>): Promise<void> => {
    setSettings(await window.clipply.updateSettings(patch));
    onChanged();
  };

  if (!settings) return <div className="p-8 text-sm text-muted">Loading settings…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-7 px-8 pt-8 pb-12">
      <header className="flex items-baseline justify-between gap-3">
        <h1 className="px-1 text-[1.75rem] leading-tight font-bold tracking-tight text-ink">Settings</h1>
        <span className="px-1 text-xs text-muted">Clipply <AppVersion client={window.clipply.updates} className="tabular-nums" /></span>
      </header>
      {message && <p role="status" className="rounded-xl bg-clip/15 px-4 py-3 text-sm text-ink">{message}</p>}

      <SettingsSection title="Appearance">
        <SettingRow label="Theme"><ThemeSwitcher /></SettingRow>
      </SettingsSection>

      <SettingsSection title="Capture" description="Copies flagged as passwords by password managers are never saved.">
        <SwitchRow label="Watch the clipboard" checked={settings.monitoring} onChange={(v) => void update({ monitoring: v })} />
        <SwitchRow label="Save copied images" checked={settings.captureImages} onChange={(v) => void update({ captureImages: v })} />
        <SwitchRow
          label="Import new screenshots"
          hint={status?.screenshotDir ? `${status.screenshotDir}${status.screenshotWatching ? '' : ' (waiting for this folder)'}` : undefined}
          checked={settings.screenshots}
          onChange={(v) => void update({ screenshots: v })}
        />
        <SwitchRow
          label="Show link previews"
          hint="Fetches the page’s preview image. The site sees your IP address, and a one-time link (sign-in, password reset) may be used up."
          checked={settings.linkPreviews}
          onChange={(v) => void update({ linkPreviews: v })}
        />
      </SettingsSection>

      <SettingsSection title="Excluded apps" description="Copies made in these apps are never saved. One window class per line, for example keepassxc.">
        <div className="space-y-2">
          <textarea
            aria-label="Excluded apps"
            rows={3}
            defaultValue={settings.excludedApps.join('\n')}
            onBlur={(e) => void update({ excludedApps: [...new Set(e.target.value.split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean))] }).catch((err: unknown) => setMessage(String(err)))}
            className="w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-sm"
          />
          <p className="text-xs text-muted">
            Find an app’s class by running <code className="font-mono">xprop WM_CLASS</code> and clicking its window.
            {status?.session === 'wayland' && ' On Wayland this works for apps that run through XWayland only.'}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="History" description="Pinned and favorite clips are always kept.">
        <SettingRow label={<label htmlFor="retention">Keep clips for</label>}>
          <select id="retention" value={settings.retentionDays} onChange={(e) => void update({ retentionDays: Number(e.target.value) })} className={selectClass}>
            {RETENTION.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
        </SettingRow>
        <StoragePanel />
      </SettingsSection>

      <SettingsSection title="Backup" description="Save your history to an encrypted file, or bring one back in.">
        <BackupPanel actions={window.clipply} />
      </SettingsSection>

      <SettingsSection title="Desktop">
        <SwitchRow label="Start Clipply when I log in" checked={settings.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
        <SwitchRow label="Keep running in the tray when the window is closed" checked={settings.closeToTray} onChange={(v) => void update({ closeToTray: v })} />
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
          <span className="text-sm font-medium">
            Open Clipply with <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-sans text-xs font-semibold">Super</kbd>{' + '}
            <kbd className="rounded border border-line bg-surface px-1.5 py-0.5 font-sans text-xs font-semibold">V</kbd>
            {status?.session === 'wayland' && <span className="mt-0.5 block text-xs font-normal text-muted">Added as a GNOME custom shortcut. GNOME’s notification list moves to Super + M.</span>}
          </span>
          {status?.gnomeShortcut ? (
            <span className="text-sm font-semibold text-accent">Ready</span>
          ) : status?.session === 'wayland' ? (
            <button
              type="button"
              onClick={() =>
                void window.clipply.installGnomeShortcut().then(
                  () => {
                    setMessage('Super + V now opens Clipply.');
                    onChanged();
                  },
                  (e: unknown) => setMessage(`The shortcut was not added: ${e instanceof Error ? e.message : String(e)}`),
                )
              }
              className={buttonClass.plain}
            >
              Add shortcut
            </button>
          ) : (
            <span className="text-sm text-muted">{status?.globalShortcut ? 'Ready' : 'Unavailable'}</span>
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Updates" description="New versions are published on GitHub Releases only. Clipply tells you when one is out; you download it yourself.">
        <UpdatePanel client={window.clipply.updates} autoCheck={settings.checkUpdates} onAutoCheck={(v) => void update({ checkUpdates: v })} />
      </SettingsSection>

      <SettingsSection title="Security" description="History is encrypted on disk with XChaCha20-Poly1305. The keys live in your system keyring.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
          <dt className="text-muted">Key storage</dt>
          <dd>{status?.keyringBackend === 'gnome_libsecret' ? 'GNOME Keyring' : status?.keyringBackend}</dd>
          <dt className="text-muted">Clipboard access</dt>
          <dd>{(status && PROVIDER_LABEL[status.provider]) ?? status?.provider}</dd>
          <dt className="text-muted">Unreadable clips</dt>
          <dd>{status?.corrupt ?? 0}</dd>
        </dl>
      </SettingsSection>
    </div>
  );
}

import { useEffect, useState, type ReactNode } from 'react';
import { BackupPanel, StoragePanel } from '@clipply/ui';

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

  if (!settings) return <div className="p-5 text-sm text-muted">Loading…</div>;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-5">
      <h1 className="text-lg font-semibold">Settings</h1>

      <Section title="Capture">
        <Toggle label="Monitor the clipboard" checked={settings.monitoring} onChange={(v) => void update({ monitoring: v })} />
        <Toggle label="Capture images" checked={settings.captureImages} onChange={(v) => void update({ captureImages: v })} />
        <Toggle
          label="Import new screenshots"
          hint={status?.screenshotDir ? `${status.screenshotDir}${status.screenshotWatching ? '' : ' (not watching)'}` : undefined}
          checked={settings.screenshots}
          onChange={(v) => void update({ screenshots: v })}
        />
        <p className="text-xs text-muted">
          Items flagged by password managers are never captured. Remote items never replace your clipboard automatically.
        </p>
      </Section>

      <Section title="Excluded apps">
        <label className="block text-sm">
          Never capture copies from these apps (window class, one per line — e.g. <code>keepassxc</code>; find one with <code>xprop WM_CLASS</code>)
          <textarea
            aria-label="Excluded apps"
            rows={3}
            defaultValue={settings.excludedApps.join('\n')}
            onBlur={(e) => void update({ excludedApps: [...new Set(e.target.value.split('\n').map((x) => x.trim().toLowerCase()).filter(Boolean))] }).catch((err: unknown) => setMessage(String(err)))}
            className="mt-1 w-full rounded-md border border-line bg-raised px-2 py-1 font-mono text-xs"
          />
        </label>
        {status?.session === 'wayland' && (
          <p className="text-xs text-muted">
            On Wayland this works only for apps running through XWayland; GNOME does not tell other apps which native Wayland window is focused.
          </p>
        )}
      </Section>

      <Section title="History">
        <label className="flex items-center justify-between text-sm">
          Keep history for
          <select
            value={settings.retentionDays}
            onChange={(e) => void update({ retentionDays: Number(e.target.value) })}
            className="rounded-md border border-line bg-raised px-2 py-1 text-sm"
          >
            {RETENTION.map((r) => <option key={r.days} value={r.days}>{r.label}</option>)}
          </select>
        </label>
        <p className="text-xs text-muted">Pinned and favorite items are always kept.</p>
        <StoragePanel />
        {message && <p role="status" className="text-xs text-muted">{message}</p>}
      </Section>

      <Section title="Backup">
        <BackupPanel actions={window.clipply} />
      </Section>

      <Section title="Desktop">
        <Toggle label="Start Clipply when I log in" checked={settings.launchAtLogin} onChange={(v) => void update({ launchAtLogin: v })} />
        <Toggle label="Keep running in the tray when the window is closed" checked={settings.closeToTray} onChange={(v) => void update({ closeToTray: v })} />
        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span>Keyboard shortcut (Super+Shift+V)</span>
            {status?.gnomeShortcut ? (
              <span className="text-xs text-accent">GNOME shortcut installed</span>
            ) : (
              <button
                type="button"
                onClick={() =>
                  void window.clipply.installGnomeShortcut().then(
                    () => {
                      setMessage('GNOME shortcut installed.');
                      onChanged();
                    },
                    (e: unknown) => setMessage(`Could not install shortcut: ${e instanceof Error ? e.message : String(e)}`),
                  )
                }
                className="rounded-md border border-line px-3 py-1 text-xs hover:border-accent"
              >
                Add GNOME shortcut
              </button>
            )}
          </div>
          <p className="text-xs text-muted">
            {status?.session === 'wayland'
              ? 'On GNOME Wayland, app-registered shortcuts only work while Clipply is focused, so Clipply adds a GNOME custom shortcut instead (Settings → Keyboard → Custom Shortcuts).'
              : status?.globalShortcut
                ? `Registered globally as ${status.globalShortcut}.`
                : 'Global shortcut not registered.'}
          </p>
        </div>
      </Section>

      <Section title="Security">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted">Key storage</dt>
          <dd>{status?.keyringBackend === 'gnome_libsecret' ? 'GNOME Keyring (libsecret)' : status?.keyringBackend}</dd>
          <dt className="text-muted">Clipboard access</dt>
          <dd>{status?.provider} {status?.session === 'wayland' ? '(XWayland)' : ''}</dd>
          <dt className="text-muted">Unreadable items</dt>
          <dd>{status?.corrupt ?? 0}</dd>
        </dl>
        <p className="text-xs text-muted">History is encrypted on disk with XChaCha20-Poly1305; the keys live in your OS keyring.</p>
      </Section>
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

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 text-sm">
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
    </label>
  );
}

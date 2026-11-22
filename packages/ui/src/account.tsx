import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CloudOff, KeyRound, Laptop, LogOut, Pause, Pencil, Play, RefreshCw, ShieldCheck, Smartphone, Trash } from 'lucide-react';
import type { AccountStatus, DeviceInfo } from '@clipply/sync-engine';

import { buttonClass } from './settings';
import { formatRelative } from './time';

/** Platform bridge for account, vault and device management (desktop: IPC; Android: in-WebView). */
export interface AccountClient {
  status(): Promise<AccountStatus>;
  onStatus(cb: () => void): () => void;
  signIn(): Promise<{ recoveryKey?: string }>;
  signOut(): Promise<void>;
  syncNow(): Promise<void>;
  enrollment(): Promise<{ approverName: string; code: string } | null>;
  acceptEnrollment(): Promise<void>;
  recover(recoveryKey: string): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  startApproval(deviceId: string): Promise<{ code: string }>;
  confirmApproval(deviceId: string): Promise<void>;
  /** Resolves with a new recovery key when the removed device had held the old one. */
  revoke(deviceId: string): Promise<{ recoveryKey?: string }>;
  rename(deviceId: string, name: string): Promise<void>;
  replaceRecoveryKey(): Promise<{ recoveryKey: string }>;
  setSyncPaused(paused: boolean): Promise<void>;
}

const message = (e: unknown): string => (e instanceof Error ? e.message.replace(/^\w+Error: /, '') : String(e));

function useAccountStatus(account: AccountClient): AccountStatus | null {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  useEffect(() => {
    const load = (): void => void account.status().then(setStatus);
    load();
    return account.onStatus(load);
  }, [account]);
  return status;
}

function Card({ children }: { children: ReactNode }) {
  return <section className="space-y-3 rounded-xl border border-line bg-raised px-5 py-4">{children}</section>;
}

function Button(props: { onClick: () => void; children: ReactNode; tone?: 'primary' | 'danger' | 'plain'; disabled?: boolean }) {
  const tone = props.tone ?? 'plain';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      className={buttonClass[tone]}
    >
      {props.children}
    </button>
  );
}

/** The 12-digit enrollment code, large and grouped for comparison across two screens. */
function Code({ code }: { code: string }) {
  return <p aria-label={`Code ${code}`} className="text-center font-mono text-2xl tracking-[0.2em] text-accent">{code}</p>;
}

/** Shown once after the vault is created. No copy button: copying would put the key into clipboard history. */
/** Crockford base32 reads O as 0 and I/L as 1, like the recovery-key parser does. */
const crockford = (s: string): string => s.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');

function RecoveryKeyNotice({ recoveryKey, replaced, onDone }: { recoveryKey: string; replaced: boolean; onDone: () => void }) {
  const lastGroup = crockford(recoveryKey.split('-').at(-1)!);
  const [typed, setTyped] = useState('');
  return (
    <div role="dialog" aria-modal="true" aria-label="Your recovery key" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6">
      <div className="max-w-lg space-y-4 rounded-2xl border border-line bg-surface p-6">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><KeyRound aria-hidden className="size-5 text-accent" /> Save your {replaced ? 'new ' : ''}recovery key</h2>
        <p className="text-sm text-muted">
          This is the only way to open your encrypted history if you lose all your devices. Clipply and its server cannot recover it.
          Write it down and keep it somewhere safe. It is shown only once.{replaced && ' Your previous recovery key no longer works.'}
        </p>
        <p className="rounded-lg bg-raised p-3 text-center font-mono text-sm break-all select-all">{recoveryKey}</p>
        <label className="block text-sm">
          Type the last group (<span className="text-muted">5 characters</span>) to confirm you saved it
          <input value={typed} onChange={(e) => setTyped(e.target.value)} className="mt-1 w-full rounded-md border border-line bg-raised px-2 py-1 font-mono uppercase" />
        </label>
        <Button tone="primary" disabled={crockford(typed) !== lastGroup} onClick={onDone}>I saved my recovery key</Button>
      </div>
    </div>
  );
}

function Enrollment({ account }: { account: AccountClient }) {
  const [pending, setPending] = useState<{ approverName: string; code: string } | null>(null);
  const [mode, setMode] = useState<'device' | 'recovery'>('device');
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode !== 'device') return;
    let alive = true;
    // Polls only while this screen is open, waiting for another device to start the approval.
    const tick = (): void => void account.enrollment().then((p) => alive && setPending(p), () => {});
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [account, mode]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <h2 className="font-medium">Connect this device to your encrypted history</h2>
      <div role="tablist" className="flex gap-2 text-sm">
        <Button tone={mode === 'device' ? 'primary' : 'plain'} onClick={() => setMode('device')}>Approve from another device</Button>
        <Button tone={mode === 'recovery' ? 'primary' : 'plain'} onClick={() => setMode('recovery')}>Use recovery key</Button>
      </div>
      {mode === 'device' ? (
        pending ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">{pending.approverName} is approving this device. Check that it shows the same code:</p>
            <Code code={pending.code} />
            <p className="text-xs text-muted">If the codes differ, do not continue — someone may be intercepting the connection.</p>
            <Button tone="primary" disabled={busy} onClick={() => void run(() => account.acceptEnrollment())}>
              <ShieldCheck aria-hidden className="size-4" /> Codes match
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">On a device that is already connected, open Devices and choose “Approve” next to this device. Waiting…</p>
        )
      ) : (
        <div className="space-y-2">
          <input
            aria-label="Recovery key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="XXXXX-XXXXX-…"
            className="w-full rounded-md border border-line bg-surface px-2 py-1.5 font-mono text-sm uppercase"
          />
          <Button tone="primary" disabled={busy || key.trim().length < 50} onClick={() => void run(() => account.recover(key))}>Recover</Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

function DeviceRow(props: { device: DeviceInfo; account: AccountClient; onChanged: () => void; onRecoveryKey: (key: string) => void; canManage: boolean }) {
  const { device, account, onChanged, canManage } = props;
  const [code, setCode] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);
  const [error, setError] = useState<string | null>(null);
  const Icon = device.platform === 'android' ? Smartphone : Laptop;
  const run = (fn: () => Promise<unknown>) => (): void => {
    setError(null);
    fn().then(onChanged, (e: unknown) => setError(message(e)));
  };

  return (
    <li className="space-y-2 rounded-lg border border-line p-3">
      <div className="flex items-center gap-3">
        <Icon aria-hidden className="size-5 text-muted" />
        <div className="min-w-0 flex-1">
          {renaming ? (
            <input aria-label="Device name" value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border border-line bg-surface px-2 py-0.5 text-sm" />
          ) : (
            <div className="truncate text-sm font-medium">{device.name}{device.isThisDevice && <span className="ml-2 text-xs text-accent">this device</span>}</div>
          )}
          <div className="text-xs text-muted">
            {device.status === 'pending' ? 'Waiting for approval' : device.status === 'revoked' ? 'Removed' : 'Connected'}
            {' · '}last seen {formatRelative(device.lastSeenAt, Date.now())}
            {device.lastSyncAt !== undefined && <> · synced {formatRelative(device.lastSyncAt, Date.now())}</>}
          </div>
        </div>
        {renaming ? (
          <Button onClick={() => { setRenaming(false); run(() => account.rename(device.id, name))(); }}>Save</Button>
        ) : (
          device.status !== 'revoked' && <button type="button" aria-label={`Rename ${device.name}`} onClick={() => setRenaming(true)} className="text-muted hover:text-ink"><Pencil aria-hidden className="size-4" /></button>
        )}
        {canManage && device.status === 'pending' && !code && (
          <Button tone="primary" onClick={() => void account.startApproval(device.id).then((r) => setCode(r.code), (e: unknown) => setError(message(e)))}>Approve</Button>
        )}
        {canManage && device.status === 'authorized' && !device.isThisDevice && (
          <Button
            tone="danger"
            onClick={() => {
              if (window.confirm(`Remove ${device.name}? It loses access immediately, and the encryption key is rotated so it cannot read anything copied from now on.`)) run(() => account.revoke(device.id).then((r) => r.recoveryKey && props.onRecoveryKey(r.recoveryKey)))();
            }}
          >
            <Trash aria-hidden className="size-4" /> Remove
          </Button>
        )}
      </div>
      {code && (
        <div className="space-y-2 rounded-md bg-surface p-3">
          <p className="text-sm text-muted">Check that {device.name} shows the same code:</p>
          <Code code={code} />
          <div className="flex gap-2">
            <Button tone="primary" onClick={() => { setCode(null); run(() => account.confirmApproval(device.id))(); }}>
              <ShieldCheck aria-hidden className="size-4" /> Codes match — approve
            </Button>
            <Button onClick={() => setCode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </li>
  );
}

/** Account + devices screen shared by desktop and Android. */
export function DevicesPanel({ account }: { account: AccountClient }) {
  const status = useAccountStatus(account);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<{ key: string; replaced: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = status?.vault === 'ready';
  const paused = status?.sync.state === 'paused';
  const loadDevices = useCallback(() => {
    if (!status?.signedIn) return;
    account.devices().then(setDevices, (e: unknown) => setError(message(e)));
  }, [account, status?.signedIn]);
  useEffect(loadDevices, [loadDevices, status?.vault]);

  if (!status) return <div aria-busy="true" className="h-24 animate-pulse rounded-xl bg-raised" />;
  if (!status.configured) {
    return <Card><p className="flex items-center gap-2 text-sm text-muted"><CloudOff aria-hidden className="size-4" /> Sync is not configured in this build. History stays on this device.</p></Card>;
  }

  const signIn = (): void => {
    setBusy(true);
    setError(null);
    account.signIn().then((r) => r.recoveryKey && setRecoveryKey({ key: r.recoveryKey, replaced: false }), (e: unknown) => setError(message(e))).finally(() => setBusy(false));
  };

  return (
    <div className="space-y-4">
      {recoveryKey && <RecoveryKeyNotice recoveryKey={recoveryKey.key} replaced={recoveryKey.replaced} onDone={() => setRecoveryKey(null)} />}
      {!status.signedIn ? (
        <Card>
          <h2 className="font-medium">Sync your clipboard across devices</h2>
          <p className="text-sm text-muted">
            Sign in with Google to connect your devices. Your clipboard is end-to-end encrypted: Google and the Clipply server only ever see ciphertext.
          </p>
          {status.sync.error && <p className="text-sm text-danger">{status.sync.error}</p>}
          <Button tone="primary" disabled={busy} onClick={signIn}>{busy ? 'Waiting for browser…' : 'Sign in with Google'}</Button>
        </Card>
      ) : (
        <Card>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">{status.email}</span>
            <span className="ml-auto text-xs text-muted">
              {status.sync.state === 'paused' ? 'Sync paused on this device'
                : status.sync.state === 'syncing' ? 'Syncing…'
                : status.sync.state === 'offline' ? 'Offline — will retry'
                : status.sync.state === 'error' ? `Sync problem: ${status.sync.error ?? 'unknown'}`
                : status.sync.lastSyncAt ? `Synced ${formatRelative(status.sync.lastSyncAt, Date.now())}` : ''}
              {status.sync.pending > 0 && ` · ${status.sync.pending} waiting to upload`}
            </span>
          </div>
          <div className="flex gap-2">
            {ready && !paused && <Button onClick={() => void account.syncNow()}><RefreshCw aria-hidden className="size-4" /> Sync now</Button>}
            {ready && (
              <Button onClick={() => void account.setSyncPaused(!paused).catch((e: unknown) => setError(message(e)))}>
                {paused ? <><Play aria-hidden className="size-4" /> Resume sync</> : <><Pause aria-hidden className="size-4" /> Pause sync</>}
              </Button>
            )}
            <Button onClick={() => void account.signOut()}><LogOut aria-hidden className="size-4" /> Sign out</Button>
          </div>
        </Card>
      )}
      {status.signedIn && status.vault === 'needs_enrollment' && <Enrollment account={account} />}
      {status.vault === 'removed' && (
        <Card><p className="text-sm text-danger">This device was removed from your account. Local history stays here; sign out and sign in again to reconnect it.</p></Card>
      )}
      {status.signedIn && devices && (
        <Card>
          <h2 className="font-medium">Devices</h2>
          <ul className="space-y-2">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} account={account} canManage={ready} onChanged={loadDevices} onRecoveryKey={(key) => setRecoveryKey({ key, replaced: true })} />
            ))}
          </ul>
          <p className="text-xs text-muted">Online status is not shown: Clipply only knows when a device last contacted the server.</p>
        </Card>
      )}
      {ready && (
        <Card>
          <h2 className="font-medium">Recovery key</h2>
          <p className="text-sm text-muted">Lost it, or someone else may have seen it? Replace it. The old key stops working and the encryption key is rotated.</p>
          <Button
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Replace your recovery key? You will need to save the new one.')) return;
              setBusy(true);
              account.replaceRecoveryKey().then((r) => setRecoveryKey({ key: r.recoveryKey, replaced: true }), (e: unknown) => setError(message(e))).finally(() => setBusy(false));
            }}
          >
            <KeyRound aria-hidden className="size-4" /> Replace recovery key
          </Button>
        </Card>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

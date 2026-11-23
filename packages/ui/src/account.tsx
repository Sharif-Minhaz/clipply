import { useCallback, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { CloudOff, KeyRound, Laptop, LogOut, Pause, Pencil, Play, QrCode, RefreshCw, ScanLine, ShieldCheck, Smartphone, Trash, type LucideProps } from 'lucide-react';
import qrcode from 'qrcode-generator';
import type { AccountStatus, DeviceInfo } from '@clipply/sync-engine';

import { buttonClass, SettingsSection } from './settings';
import { formatRelative } from './time';

/** Platform bridge for account, vault and device management (desktop: IPC; Android: in-WebView). */
export interface AccountClient {
  status(): Promise<AccountStatus>;
  onStatus(cb: () => void): () => void;
  signIn(): Promise<{ recoveryKey?: string }>;
  signOut(): Promise<void>;
  syncNow(): Promise<void>;
  /** `approved`: the server already authorized this device; only the codes are left to compare. */
  /** `rejoin`: this device was connected but missed too many device-list changes to verify the new key itself. */
  /** `paired`: matched by QR code; nothing to compare, the device joins on its own. */
  enrollment(): Promise<{ approverName: string; code: string; approved?: boolean; rejoin?: boolean; paired?: boolean } | null>;
  /** Text of a fresh pairing QR code for this device (each valid 10 minutes). */
  pairingQr(): Promise<string>;
  /** Polled while a connected device shows its QR: the device it just approved, if one scanned it. */
  checkPairing(): Promise<{ name: string } | null>;
  /** Where a camera is available (Android): scan another device's QR and pair; null when cancelled. */
  scanPairing?: () => Promise<{ name: string } | null>;
  acceptEnrollment(): Promise<void>;
  recover(recoveryKey: string): Promise<void>;
  devices(): Promise<DeviceInfo[]>;
  startApproval(deviceId: string): Promise<{ code: string }>;
  /** For an approved device that never accepted its keyring and is joining again. */
  approvalCode(deviceId: string): Promise<{ code: string }>;
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
  return <section className="space-y-4 rounded-2xl border border-line bg-raised p-4 sm:p-5">{children}</section>;
}

/** A whole-row button inside a grouped list: icon tile, label, optional hint. */
function ActionRow(props: { icon: ComponentType<LucideProps>; label: string; hint?: string; onClick: () => void; tone?: 'danger'; disabled?: boolean; pressed?: boolean }) {
  const Icon = props.icon;
  const danger = props.tone === 'danger';
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      {...(props.pressed !== undefined ? { 'aria-pressed': props.pressed } : {})}
      className="flex w-full items-center gap-3.5 text-left transition-colors hover:bg-surface/70 disabled:opacity-50"
    >
      <span aria-hidden className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${danger ? 'bg-danger/10 text-danger' : 'bg-surface text-accent'}`}>
        <Icon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={`block text-sm font-semibold ${danger ? 'text-danger' : 'text-ink'}`}>{props.label}</span>
        {props.hint && <span className="mt-0.5 block text-xs text-muted">{props.hint}</span>}
      </span>
    </button>
  );
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
  const [pending, setPending] = useState<{ approverName: string; code: string; approved?: boolean; rejoin?: boolean; paired?: boolean } | null>(null);
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
      <h2 className="text-base font-bold text-ink">Connect this device to your encrypted history</h2>
      <div role="radiogroup" aria-label="How to connect" className="grid grid-cols-2 gap-0.5 rounded-xl border border-line bg-surface p-1">
        {([['device', 'Another device'], ['recovery', 'Recovery key']] as const).map(([m, label]) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition-colors ${mode === m ? 'bg-raised font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'device' ? (
        pending?.paired ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted">
            <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Connecting to {pending.approverName}…
          </p>
        ) : pending ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {pending.rejoin
                ? <>Your device list changed while this device was offline, and it can no longer check the new encryption key by itself. On {pending.approverName}, open Devices and tap Show code next to this device. Check that it shows the same code:</>
                : pending.approved
                ? <>{pending.approverName} approved this device, but setup did not finish. On {pending.approverName}, open Devices and tap Show code next to this device. Check that it shows the same code:</>
                : <>{pending.approverName} is approving this device. Check that it shows the same code:</>}
            </p>
            <Code code={pending.code} />
            <p className="text-xs text-muted">If the codes differ, do not continue — someone may be intercepting the connection.</p>
            <Button tone="primary" disabled={busy} onClick={() => void run(() => account.acceptEnrollment())}>
              <ShieldCheck aria-hidden className="size-4" /> Codes match
            </Button>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted">On a connected phone, open Clipply → Devices → <span className="font-semibold">Scan QR code</span> and scan this:</p>
            <PairingQr account={account} />
            {account.scanPairing && (
              <Button disabled={busy} onClick={() => void run(async () => void (await account.scanPairing!()))}>
                <ScanLine aria-hidden className="size-4" /> Scan the other device's code instead
              </Button>
            )}
            <p className="text-xs text-muted">No camera? Open Clipply on a connected device: it asks you to approve this one, and you compare a code instead. Waiting…</p>
          </div>
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
  const [joinCode, setJoinCode] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name);
  const [error, setError] = useState<string | null>(null);
  const Icon = device.platform === 'android' ? Smartphone : Laptop;
  const pending = device.status === 'pending';
  const run = (fn: () => Promise<unknown>) => (): void => {
    setError(null);
    fn().then(onChanged, (e: unknown) => setError(message(e)));
  };
  const iconButton = 'flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors';
  const now = Date.now();

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3.5">
        <span aria-hidden className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${device.isThisDevice || pending ? 'bg-clip/15 text-accent' : 'bg-surface text-muted'}`}>
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                setRenaming(false);
                run(() => account.rename(device.id, name))();
              }}
            >
              <input aria-label="Device name" autoFocus value={name} onChange={(e) => setName(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm" />
              <button type="submit" className={buttonClass.primary}>Save</button>
            </form>
          ) : (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[0.9375rem] font-semibold break-words text-ink">{device.name}</span>
              {device.isThisDevice && <span className="rounded-md bg-clip/15 px-1.5 py-0.5 text-xs font-semibold text-accent">This device</span>}
            </p>
          )}
          <p className={`mt-0.5 text-xs ${pending ? 'font-semibold text-accent' : 'text-muted'}`}>
            {pending
              ? 'Waiting for approval'
              : device.lastSyncAt !== undefined
                ? `Synced ${formatRelative(device.lastSyncAt, now)}`
                : `Seen ${formatRelative(device.lastSeenAt, now)}`}
          </p>
        </div>
        {!renaming && (
          <div className="flex shrink-0 items-center">
            <button type="button" aria-label={`Rename ${device.name}`} title="Rename" onClick={() => setRenaming(true)} className={`${iconButton} hover:bg-surface hover:text-ink`}>
              <Pencil aria-hidden className="size-4" />
            </button>
            {canManage && device.status === 'authorized' && !device.isThisDevice && (
              <button
                type="button"
                aria-label={`Remove ${device.name}`}
                title="Remove"
                onClick={() => {
                  if (window.confirm(`Remove ${device.name}? It loses access immediately, and the encryption key is rotated so it cannot read anything copied from now on.`)) run(() => account.revoke(device.id).then((r) => r.recoveryKey && props.onRecoveryKey(r.recoveryKey)))();
                }}
                className={`${iconButton} hover:bg-danger/10 hover:text-danger`}
              >
                <Trash aria-hidden className="size-4" />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2 pl-[3.375rem] empty:hidden">
        {canManage && pending && !code && (
          <Button tone="primary" onClick={() => void account.startApproval(device.id).then((r) => setCode(r.code), (e: unknown) => setError(message(e)))}>
            <ShieldCheck aria-hidden className="size-4" /> Approve
          </Button>
        )}
        {canManage && device.status === 'authorized' && !device.isThisDevice && device.lastSyncAt === undefined && !joinCode && (
          <Button onClick={() => void account.approvalCode(device.id).then((r) => setJoinCode(r.code), (e: unknown) => setError(message(e)))}>
            <ShieldCheck aria-hidden className="size-4" /> Show code
          </Button>
        )}
      </div>
      {code && (
        <div className="space-y-3 rounded-xl bg-surface p-4">
          <p className="text-sm text-muted">Check that {device.name} shows the same code:</p>
          <Code code={code} />
          <div className="flex flex-wrap gap-2">
            <Button tone="primary" onClick={() => { setCode(null); run(() => account.confirmApproval(device.id))(); }}>
              <ShieldCheck aria-hidden className="size-4" /> Codes match, approve
            </Button>
            <Button onClick={() => setCode(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {joinCode && (
        <div className="space-y-3 rounded-xl bg-surface p-4">
          <p className="text-sm text-muted">If {device.name} has not finished setup, check that it shows this code, then tap Codes match on {device.name}:</p>
          <Code code={joinCode} />
          <Button onClick={() => setJoinCode(null)}>Close</Button>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function syncLabel(status: AccountStatus): string {
  const s = status.sync;
  if (s.state === 'paused') return 'Sync paused on this device';
  if (s.state === 'syncing') return 'Syncing…';
  if (s.state === 'offline') return 'Offline. Clipply will retry.';
  if (s.state === 'error') return `Sync problem: ${s.error ?? 'unknown'}`;
  return s.lastSyncAt ? `Synced ${formatRelative(s.lastSyncAt, Date.now())}` : 'Not synced yet';
}

/**
 * Sync button for the history screens. Mounting it syncs too, so opening the history page always
 * fetches what other devices sent. Hidden when this device is not syncing.
 */
export function SyncButton({ account }: { account: AccountClient }) {
  const status = useAccountStatus(account);
  useEffect(() => void account.syncNow().catch(() => undefined), [account]);
  if (!status?.signedIn || status.vault !== 'ready' || status.sync.state === 'paused') return null;
  const syncing = status.sync.state === 'syncing';
  return (
    <button
      type="button"
      onClick={() => void account.syncNow()}
      disabled={syncing}
      title={syncLabel(status)}
      aria-label={syncing ? 'Syncing' : `Sync now. ${syncLabel(status)}`}
      className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-raised text-ink shadow-[0_6px_20px_-12px_rgb(8_60_70/0.45)] ring-1 ring-line/70 hover:text-accent disabled:opacity-80 in-data-hero:bg-white/12 in-data-hero:text-white in-data-hero:shadow-none in-data-hero:ring-white/20 in-data-hero:backdrop-blur in-data-hero:hover:bg-white/20"
    >
      <RefreshCw aria-hidden className={`size-5 ${syncing ? 'animate-spin' : ''} ${status.sync.state === 'error' || status.sync.state === 'offline' ? 'text-danger in-data-hero:text-red-200' : ''}`} />
    </button>
  );
}

/** Signing out wipes this device, so say what is lost before doing it. */
function confirmSignOut(pending: number): boolean {
  const unsynced = pending > 0 ? ` ${pending} change${pending === 1 ? " hasn't" : "s haven't"} synced yet and will be lost.` : '';
  return window.confirm(`Sign out? This deletes the clipboard history and keys on this device. Clips already synced stay in your account.${unsynced}`);
}

/** Dark modules on a white square, so any scanner reads it in either theme. */
export function QrSvg({ text, label }: { text: string; label: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
    return { d, n };
  }, [text]);
  const size = path.n + 8; // 4-module quiet zone on each side
  return (
    <svg role="img" aria-label={label} viewBox={`-4 -4 ${size} ${size}`} shapeRendering="crispEdges" className="mx-auto block size-56 rounded-lg">
      <rect x={-4} y={-4} width={size} height={size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

/** This device's pairing QR, refreshed before the 10-minute secret expires. */
function PairingQr({ account }: { account: AccountClient }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = (): void => void account.pairingQr().then((t) => alive && setText(t), () => {});
    load();
    const t = setInterval(load, 8 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [account]);
  return text ? <QrSvg text={text} label="Pairing QR code" /> : <div aria-busy="true" className="mx-auto size-56 animate-pulse rounded-lg bg-surface" />;
}

/** On a connected device: let a new one join by scanning its QR, or by showing ours for it to scan. */
function AddDevice({ account, onAdded }: { account: AccountClient; onAdded: () => void }) {
  const [showing, setShowing] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!showing) return;
    let alive = true;
    // Waits for the new device to scan the code shown here; it is approved as soon as its proof checks out.
    const t = setInterval(() => {
      void account.checkPairing().then((r) => {
        if (!alive || !r) return;
        setShowing(false);
        setAdded(r.name);
        onAdded();
      }, (e: unknown) => alive && setError(message(e)));
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [account, showing, onAdded]);

  const scan = (): void => {
    setError(null);
    account.scanPairing!().then((r) => {
      if (!r) return;
      setAdded(r.name);
      onAdded();
    }, (e: unknown) => setError(message(e)));
  };

  return (
    <SettingsSection title="Add a device" description="Sign in on the new device with the same Google account first.">
      {account.scanPairing && <ActionRow icon={ScanLine} label="Scan its QR code" hint="Point the camera at the code the new device shows" onClick={scan} />}
      <ActionRow
        icon={QrCode}
        label={showing ? 'Hide this device’s QR code' : 'Show this device’s QR code'}
        hint="For a new phone to scan"
        pressed={showing}
        onClick={() => { setAdded(null); setError(null); setShowing(!showing); }}
      />
      {showing && (
        <div className="space-y-3 bg-surface/60 py-5!">
          <PairingQr account={account} />
          <p className="text-center text-xs text-muted">On the new phone, tap “Scan the other device's code instead”.</p>
        </div>
      )}
      {added && <p role="status" className="flex items-center gap-2 text-sm font-semibold text-accent"><ShieldCheck aria-hidden className="size-4" /> {added} is connected.</p>}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </SettingsSection>
  );
}

/** Shown on every screen of a connected device while another device waits for its approval. */
export function JoinRequestBanner({ account, onReview }: { account: AccountClient; onReview: () => void }) {
  const status = useAccountStatus(account);
  const requests = status?.vault === 'ready' ? (status.joinRequests ?? []) : [];
  if (requests.length === 0) return null;
  const who = requests.length === 1 ? requests[0]!.name : `${requests.length} devices`;
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-ink">
      <ShieldCheck aria-hidden className="size-5 shrink-0 text-accent" />
      <span className="min-w-0 flex-1"><span className="font-semibold">{who}</span> {requests.length === 1 ? 'wants' : 'want'} to join your account.</span>
      <Button tone="primary" onClick={onReview}>Review</Button>
    </div>
  );
}

const DOT: Record<AccountStatus['sync']['state'], string> = {
  idle: 'bg-accent', syncing: 'bg-clip animate-pulse', paused: 'bg-muted', offline: 'bg-muted', error: 'bg-danger', off: 'bg-muted',
};

/** Who is signed in and how sync stands; the actions that apply right now sit underneath. */
function AccountHeader({ status, account, onError }: { status: AccountStatus; account: AccountClient; onError: (m: string) => void }) {
  const ready = status.vault === 'ready';
  const paused = status.sync.state === 'paused';
  const email = status.email ?? '';
  return (
    <section className="rounded-2xl border border-line bg-raised p-4 sm:p-5">
      <div className="flex items-center gap-3.5">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-full bg-strip text-lg font-bold text-white uppercase">{email.charAt(0) || '?'}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-semibold text-ink" title={email}>{email}</p>
          <p className={`mt-0.5 flex items-center gap-2 text-sm ${status.sync.state === 'error' ? 'text-danger' : 'text-muted'}`}>
            {ready && <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[status.sync.state]}`} />}
            <span className="min-w-0">
              {ready ? syncLabel(status) : status.vault === 'needs_enrollment' ? 'Not connected yet' : status.vault === 'removed' ? 'Removed from your account' : 'Setting up…'}
              {ready && status.sync.pending > 0 && `. ${status.sync.pending} waiting to upload`}
            </span>
          </p>
        </div>
      </div>
      {ready && (
        <div className="mt-4 flex gap-2 *:flex-1">
          {!paused && <Button onClick={() => void account.syncNow()}><RefreshCw aria-hidden className={`size-4 ${status.sync.state === 'syncing' ? 'animate-spin' : ''}`} /> Sync now</Button>}
          <Button onClick={() => void account.setSyncPaused(!paused).catch((e: unknown) => onError(message(e)))}>
            {paused ? <><Play aria-hidden className="size-4" /> Resume sync</> : <><Pause aria-hidden className="size-4" /> Pause sync</>}
          </Button>
        </div>
      )}
    </section>
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
  const loadDevices = useCallback(() => {
    if (!status?.signedIn) return;
    account.devices().then(setDevices, (e: unknown) => setError(message(e)));
  }, [account, status?.signedIn]);
  // Reload when a device starts or stops waiting, so it appears here without reopening the screen.
  const requestIds = status?.joinRequests?.map((d) => d.id).join() ?? '';
  useEffect(loadDevices, [loadDevices, status?.vault, requestIds]);

  if (!status) return <div aria-busy="true" className="h-28 animate-pulse rounded-2xl bg-raised" />;
  if (!status.configured) {
    return <Card><p className="flex items-center gap-2 text-sm text-muted"><CloudOff aria-hidden className="size-4" /> Sync is not configured in this build. History stays on this device.</p></Card>;
  }

  const signIn = (): void => {
    setBusy(true);
    setError(null);
    const attempt = async (): Promise<void> => {
      try {
        const r = await account.signIn();
        if (r.recoveryKey) setRecoveryKey({ key: r.recoveryKey, replaced: false });
      } catch (e) {
        // This device still belongs to another account (signed out by an older version, which kept its history).
        if (!message(e).endsWith('device_id_taken')) throw e;
        if (!window.confirm('This device still has clipboard history and keys from the account used here before. Signing in with a different account deletes them from this device; clips already synced stay in that account. Continue?')) return;
        await account.signOut();
        await attempt();
      }
    };
    attempt().catch((e: unknown) => setError(message(e))).finally(() => setBusy(false));
  };

  const shown = devices?.filter((d) => d.status !== 'revoked') ?? [];
  // Waiting devices first: they need something from you.
  shown.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));

  return (
    <div className="space-y-6">
      {recoveryKey && <RecoveryKeyNotice recoveryKey={recoveryKey.key} replaced={recoveryKey.replaced} onDone={() => setRecoveryKey(null)} />}
      {!status.signedIn ? (
        <Card>
          <span aria-hidden className="flex size-12 items-center justify-center rounded-2xl bg-strip text-white"><RefreshCw className="size-6" /></span>
          <div className="space-y-1.5">
            <h2 className="text-lg font-bold text-ink">Sync your clipboard across devices</h2>
            <p className="text-sm text-muted">
              Sign in with Google to connect your devices. Your clipboard is end-to-end encrypted: Google and the Clipply server only ever see ciphertext.
            </p>
          </div>
          {status.sync.error && <p className="text-sm text-danger">{status.sync.error}</p>}
          <div className="*:w-full sm:*:w-auto">
            <Button tone="primary" disabled={busy} onClick={signIn}>{busy ? 'Waiting for browser…' : 'Sign in with Google'}</Button>
          </div>
        </Card>
      ) : (
        <AccountHeader status={status} account={account} onError={setError} />
      )}
      {status.signedIn && status.vault === 'needs_enrollment' && <Enrollment account={account} />}
      {status.vault === 'removed' && (
        <Card><p className="text-sm text-danger">This device was removed from your account. To reconnect it, sign out (this clears the history on this device) and sign in again, then approve it from a connected device.</p></Card>
      )}
      {status.signedIn && devices && (
        <SettingsSection title={`Your devices (${shown.length})`} description="Clipply only knows when each device last reached the server, not whether it is online now.">
          {/* Removed devices stay on the server as tombstones (blocking re-registration) until purged; not worth showing. */}
          {shown.map((d) => (
            <DeviceRow key={d.id} device={d} account={account} canManage={ready} onChanged={loadDevices} onRecoveryKey={(key) => setRecoveryKey({ key, replaced: true })} />
          ))}
        </SettingsSection>
      )}
      {ready && <AddDevice account={account} onAdded={loadDevices} />}
      {ready && (
        <SettingsSection title="Recovery key" description="The old key stops working and the encryption key is rotated. Do this if the key is lost or someone else may have seen it.">
          <ActionRow
            icon={KeyRound}
            label="Replace recovery key"
            hint="You will save the new one right away"
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Replace your recovery key? You will need to save the new one.')) return;
              setBusy(true);
              account.replaceRecoveryKey().then((r) => setRecoveryKey({ key: r.recoveryKey, replaced: true }), (e: unknown) => setError(message(e))).finally(() => setBusy(false));
            }}
          />
        </SettingsSection>
      )}
      {status.signedIn && (
        <SettingsSection title="This device" description="Clips already synced stay in your account and on your other devices.">
          <ActionRow
            icon={LogOut}
            tone="danger"
            label="Sign out"
            hint="Deletes the history and keys on this device"
            onClick={() => confirmSignOut(status.sync.pending) && void account.signOut().catch((e: unknown) => setError(message(e)))}
          />
        </SettingsSection>
      )}
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    </div>
  );
}

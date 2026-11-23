import { useEffect, useState, type ReactNode } from 'react';
import { ClipboardPaste, Clipboard, Laptop, Pin, Settings as SettingsIcon, Star } from 'lucide-react';
import { AddClip, ClipList, ClipplyProvider, DevicesPanel, ItemViewer, JoinRequestBanner, SearchStrip, SyncButton, UpdateNotice } from '@clipply/ui';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import logo from './logo.png';
import { boot, type Runtime } from './services/runtime';
import { SettingsScreen } from './screens/SettingsScreen';

type Tab = 'clipboard' | 'favorites' | 'pinned' | 'devices' | 'settings';
const TABS: Array<{ tab: Tab; label: string; icon: typeof Clipboard; hint?: string }> = [
  { tab: 'clipboard', label: 'Clipboard', icon: Clipboard, hint: 'Your copied items' },
  { tab: 'favorites', label: 'Favorites', icon: Star, hint: 'Your starred clips' },
  { tab: 'pinned', label: 'Pinned', icon: Pin, hint: 'Your pinned clips' },
  { tab: 'devices', label: 'Devices', icon: Laptop },
  { tab: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function App() {
  const [rt, setRt] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    boot().then(setRt, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error) return <Centered><p role="alert" className="text-sm text-danger">Clipply could not start: {error}</p></Centered>;
  if (!rt) return <Centered><div aria-busy="true" className="size-8 animate-pulse rounded-full bg-raised" /></Centered>;
  return (
    <ClipplyProvider client={rt.client}>
      <Shell rt={rt} />
    </ClipplyProvider>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-dvh items-center justify-center bg-surface p-6 text-ink">{children}</div>;
}

function Shell({ rt }: { rt: Runtime }) {
  const [tab, setTab] = useState<Tab>('clipboard');
  return (
    <div className="flex h-dvh flex-col bg-surface pt-[env(safe-area-inset-top)] text-ink">
      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab !== 'devices' && (
          <div className="px-4 pt-4 empty:hidden"><JoinRequestBanner account={rt.account} onReview={() => setTab('devices')} /></div>
        )}
        {tab === 'clipboard' && <History rt={rt} tab={0} base={{}} empty="Nothing saved yet. Tap + then Save clipboard to save what you copied, share text or files to Clipply, or use the Clipply tile in Quick Settings." />}
        {tab === 'favorites' && <History rt={rt} tab={1} base={{ favorite: true }} empty="Star a clip to keep it here for quick access." />}
        {tab === 'pinned' && <History rt={rt} tab={2} base={{ pinned: true }} empty="Pin a clip to keep it at hand. Pinned clips are never deleted by cleanup." />}
        {tab === 'devices' && <div className="space-y-6 px-4 pt-6 pb-10"><h1 className="px-1 text-[1.75rem] leading-tight font-bold tracking-tight text-ink">Devices</h1><DevicesPanel account={rt.account} /></div>}
        {tab === 'settings' && <SettingsScreen rt={rt} />}
      </main>
      <nav aria-label="Main" className="mx-3 mb-[calc(env(safe-area-inset-bottom)+0.5rem)] grid grid-cols-5 rounded-3xl bg-raised p-1.5 text-muted shadow-[0_10px_30px_-10px_rgb(8_50_60/0.35)] ring-1 ring-line/60">
        {TABS.map(({ tab: t, label, icon: Icon }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`flex flex-col items-center gap-1 rounded-2xl py-1.5 text-xs ${tab === t ? 'font-semibold text-accent' : ''}`}
          >
            <span aria-hidden className={`flex h-8 w-14 items-center justify-center rounded-full transition-colors ${tab === t ? 'bg-accent/12' : ''}`}>
              <Icon className="size-5.5" />
            </span>
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function History({ rt, tab, base, empty }: { rt: Runtime; tab: number; base: ListFilter; empty: string }) {
  const { hint } = TABS[tab]!;
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<ClipKind[]>([]);
  const [open, setOpen] = useState<ClipView | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const filter: ListFilter = { ...base, ...(query ? { query } : {}), ...(kinds.length ? { kinds } : {}) };

  const saveClipboard = (): void => {
    rt.captureNow().then(setToast, (e: unknown) => setToast(e instanceof Error ? e.message : String(e)));
    setTimeout(() => setToast(null), 2500);
  };

  return (
    <>
    {/* The floating button and toast stay outside the spaced list: space-y gives every child but the last a bottom margin, which moved the button when the toast appeared. */}
    <SearchStrip
      hero
      heading={
        <div className="flex items-center gap-3">
          <img src={logo} alt="" className="size-12 rounded-2xl shadow-[0_8px_20px_-8px_rgb(0_0_0/0.6)]" />
          <div>
            <h1 className="text-xl leading-tight font-bold tracking-tight">Clipply</h1>
            <p className="text-xs text-white/80">{hint}</p>
          </div>
        </div>
      }
      query={query} onQuery={setQuery} kinds={kinds} onKinds={setKinds} action={<SyncButton account={rt.account} />}
    />
    <div className="space-y-3 px-3 pt-3 pb-24">
      {Object.keys(base).length === 0 && <UpdateNotice client={rt.updates} variant="banner" />}
      <ClipList filter={filter} onOpen={setOpen} emptyText={empty} />
    </div>
      {open && <ItemViewer item={open} onClose={() => setOpen(null)} />}
      {Object.keys(base).length === 0 && (
        <AddClip
          dial
          className="fixed right-4 bottom-[calc(6.25rem+env(safe-area-inset-bottom))] z-20"
          actions={[{ icon: ClipboardPaste, label: 'Save clipboard', onClick: saveClipboard }]}
        />
      )}
      {toast && <p role="status" className="fixed inset-x-4 bottom-[calc(10.5rem+env(safe-area-inset-bottom))] rounded-xl bg-frame px-4 py-3 text-center text-sm text-frame-ink shadow-lg">{toast}</p>}
    </>
  );
}

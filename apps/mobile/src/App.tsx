import { useEffect, useState, type ReactNode } from 'react';
import { ClipboardPaste, Clipboard, Laptop, Pin, Settings as SettingsIcon, Star } from 'lucide-react';
import { ClipList, ClipplyProvider, DevicesPanel, ItemViewer, SearchStrip, SyncButton } from '@clipply/ui';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { boot, type Runtime } from './services/runtime';
import { SettingsScreen } from './screens/SettingsScreen';

type Tab = 'clipboard' | 'favorites' | 'pinned' | 'devices' | 'settings';
const TABS: Array<{ tab: Tab; label: string; icon: typeof Clipboard }> = [
  { tab: 'clipboard', label: 'Clipboard', icon: Clipboard },
  { tab: 'favorites', label: 'Favorites', icon: Star },
  { tab: 'pinned', label: 'Pinned', icon: Pin },
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
        {tab === 'clipboard' && <History rt={rt} base={{}} empty="Nothing saved yet. Tap Save clipboard, share text or files to Clipply, or use the Clipply tile in Quick Settings." />}
        {tab === 'favorites' && <History rt={rt} base={{ favorite: true }} empty="Star a clip to keep it here for quick access." />}
        {tab === 'pinned' && <History rt={rt} base={{ pinned: true }} empty="Pin a clip to keep it at hand. Pinned clips are never deleted by cleanup." />}
        {tab === 'devices' && <div className="space-y-4 px-4 py-6"><h1 className="text-2xl font-bold tracking-tight">Devices</h1><DevicesPanel account={rt.account} /></div>}
        {tab === 'settings' && <SettingsScreen rt={rt} />}
      </main>
      <nav aria-label="Main" className="grid grid-cols-5 bg-frame pb-[env(safe-area-inset-bottom)] text-frame-muted">
        {TABS.map(({ tab: t, label, icon: Icon }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`relative flex flex-col items-center gap-1 pt-2.5 pb-2 text-xs ${tab === t ? 'font-semibold text-frame-ink' : ''}`}
          >
            {tab === t && <span aria-hidden className="absolute top-0 h-1 w-8 rounded-b bg-clip" />}
            <Icon aria-hidden className={`size-[22px] ${tab === t ? 'text-clip' : ''}`} />
            {label}
          </button>
        ))}
      </nav>
    </div>
  );
}

function History({ rt, base, empty }: { rt: Runtime; base: ListFilter; empty: string }) {
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
    <div className="space-y-3 px-3 pb-24">
      <SearchStrip query={query} onQuery={setQuery} kinds={kinds} onKinds={setKinds} action={<SyncButton account={rt.account} />} />
      <ClipList filter={filter} onOpen={setOpen} emptyText={empty} />
      {open && <ItemViewer item={open} onClose={() => setOpen(null)} />}
      {Object.keys(base).length === 0 && (
        <button
          type="button"
          onClick={saveClipboard}
          className="fixed right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] flex items-center gap-2 rounded-2xl bg-frame px-5 py-3.5 text-base font-semibold text-frame-ink shadow-lg"
        >
          <ClipboardPaste aria-hidden className="size-5 text-clip" /> Save clipboard
        </button>
      )}
      {toast && <p role="status" className="fixed inset-x-4 bottom-[calc(9rem+env(safe-area-inset-bottom))] rounded-xl bg-frame px-4 py-3 text-center text-sm text-frame-ink shadow-lg">{toast}</p>}
    </div>
  );
}

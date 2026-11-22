import { useEffect, useState, type ReactNode } from 'react';
import { ClipboardPaste, Clipboard, Laptop, Pin, Settings as SettingsIcon, Star } from 'lucide-react';
import { ClipList, ClipplyProvider, DevicesPanel, ItemViewer, KindFilter, SearchBar } from '@clipply/ui';
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
        {tab === 'clipboard' && <History rt={rt} base={{}} empty="Nothing saved yet. Tap “Save clipboard”, share text or images to Clipply, or use the Quick Settings tile." />}
        {tab === 'favorites' && <History rt={rt} base={{ favorite: true }} empty="No favorites yet." />}
        {tab === 'pinned' && <History rt={rt} base={{ pinned: true }} empty="No pinned items yet." />}
        {tab === 'devices' && <div className="space-y-4 p-4"><h1 className="text-lg font-semibold">Devices</h1><DevicesPanel account={rt.account} /></div>}
        {tab === 'settings' && <SettingsScreen rt={rt} />}
      </main>
      <nav aria-label="Main" className="grid grid-cols-5 border-t border-line bg-raised pb-[env(safe-area-inset-bottom)]">
        {TABS.map(({ tab: t, label, icon: Icon }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`flex flex-col items-center gap-0.5 py-2 text-[11px] ${tab === t ? 'text-accent' : 'text-muted'}`}
          >
            <Icon aria-hidden className="size-5" />
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
    <div className="space-y-3 p-4">
      <SearchBar value={query} onChange={setQuery} />
      <KindFilter value={kinds} onChange={setKinds} />
      <ClipList filter={filter} onOpen={setOpen} emptyText={empty} />
      {open && <ItemViewer item={open} onClose={() => setOpen(null)} />}
      {Object.keys(base).length === 0 && (
        <button
          type="button"
          onClick={saveClipboard}
          className="fixed right-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] flex items-center gap-2 rounded-full bg-accent px-4 py-3 text-sm font-medium text-surface shadow-lg"
        >
          <ClipboardPaste aria-hidden className="size-4" /> Save clipboard
        </button>
      )}
      {toast && <p role="status" className="fixed inset-x-4 bottom-[calc(8rem+env(safe-area-inset-bottom))] rounded-lg bg-raised p-3 text-center text-sm shadow">{toast}</p>}
    </div>
  );
}

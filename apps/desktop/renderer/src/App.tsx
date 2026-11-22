import { useCallback, useEffect, useRef, useState } from 'react';
import { Clipboard, Laptop, Pause, Pin, Play, Settings as SettingsIcon, Star } from 'lucide-react';
import { ClipList, ItemViewer, KindFilter, SearchBar } from '@clipply/ui';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import type { DesktopStatus } from '../../electron/shared/api';
import { DevicesScreen } from './DevicesScreen';
import { SettingsScreen } from './SettingsScreen';
import { VaultProblem } from './VaultProblem';

type Tab = 'clipboard' | 'favorites' | 'pinned' | 'devices' | 'settings';

const NAV: Array<{ tab: Tab; label: string; icon: typeof Clipboard }> = [
  { tab: 'clipboard', label: 'Clipboard', icon: Clipboard },
  { tab: 'favorites', label: 'Favorites', icon: Star },
  { tab: 'pinned', label: 'Pinned', icon: Pin },
  { tab: 'devices', label: 'Devices', icon: Laptop },
  { tab: 'settings', label: 'Settings', icon: SettingsIcon },
];

export function useStatus(): [DesktopStatus | null, () => void] {
  const [status, setStatus] = useState<DesktopStatus | null>(null);
  const refresh = useCallback(() => void window.clipply.getStatus().then(setStatus), []);
  useEffect(() => {
    refresh();
    const offStatus = window.clipply.onStatus(refresh);
    const offChanged = window.clipply.onChanged(refresh);
    return () => {
      offStatus();
      offChanged();
    };
  }, [refresh]);
  return [status, refresh];
}

export function App() {
  const [tab, setTab] = useState<Tab>('clipboard');
  const [status, refresh] = useStatus();

  if (status && status.vault !== 'ready') return <VaultProblem status={status} />;

  return (
    <div className="flex h-screen bg-surface text-ink">
      <nav aria-label="Main" className="flex w-52 shrink-0 flex-col gap-1 border-r border-line p-3">
        <div className="mb-4 flex items-center gap-2 px-2 pt-1 text-sm font-semibold tracking-tight">
          <span aria-hidden className="flex size-6 items-center justify-center rounded-md bg-accent/20 text-accent">
            <Clipboard className="size-3.5" />
          </span>
          Clipply
        </div>
        {NAV.map(({ tab: t, label, icon: Icon }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors ${
              tab === t ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/60 hover:text-ink'
            }`}
          >
            <Icon aria-hidden className="size-4" />
            {label}
          </button>
        ))}
        <div className="mt-auto">
          {status && (
            <button
              type="button"
              onClick={() => void window.clipply.updateSettings({ monitoring: !status.monitoring }).then(refresh)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted hover:text-ink"
            >
              {status.monitoring ? <Pause aria-hidden className="size-3.5" /> : <Play aria-hidden className="size-3.5" />}
              {status.monitoring ? 'Monitoring' : 'Paused'} · {status.items} items
            </button>
          )}
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {tab === 'clipboard' && <HistoryScreen base={{}} empty="Nothing copied yet. Copy something anywhere and it shows up here." />}
        {tab === 'favorites' && <HistoryScreen base={{ favorite: true }} empty="No favorites yet." />}
        {tab === 'pinned' && <HistoryScreen base={{ pinned: true }} empty="No pinned items yet." />}
        {tab === 'devices' && <DevicesScreen />}
        {tab === 'settings' && <SettingsScreen status={status} onChanged={refresh} />}
      </main>
    </div>
  );
}

function HistoryScreen({ base, empty }: { base: ListFilter; empty: string }) {
  const [query, setQuery] = useState('');
  const [kinds, setKinds] = useState<ClipKind[]>([]);
  const [open, setOpen] = useState<ClipView | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const filter: ListFilter = { ...base, ...(query ? { query } : {}), ...(kinds.length ? { kinds } : {}) };
  return (
    <div className="mx-auto max-w-3xl space-y-3 p-5">
      <SearchBar value={query} onChange={setQuery} inputRef={searchRef} />
      <KindFilter value={kinds} onChange={setKinds} />
      <ClipList filter={filter} onOpen={setOpen} emptyText={empty} deviceNames={{}} />
      {open && <ItemViewer item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

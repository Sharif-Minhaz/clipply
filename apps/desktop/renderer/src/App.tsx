import { useCallback, useEffect, useRef, useState } from 'react';
import logo from './logo.png';
import { Clipboard, Laptop, Pause, Pin, Play, Settings as SettingsIcon, Star } from 'lucide-react';
import { AddClip, ClipList, ItemViewer, SearchStrip, SyncButton, UpdateNotice } from '@clipply/ui';
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
      <nav aria-label="Main" className="flex w-56 shrink-0 flex-col gap-0.5 bg-frame px-3 py-4 text-frame-ink">
        <div className="mb-5 flex items-center gap-2.5 px-2">
          <img src={logo} alt="" className="size-8 rounded-lg" />
          <span className="text-lg font-bold tracking-tight">Clipply</span>
        </div>
        {NAV.map(({ tab: t, label, icon: Icon }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`relative flex items-center gap-3 rounded-lg px-3 py-2 text-[0.9375rem] transition-colors ${
              tab === t ? 'bg-frame-hover font-semibold text-frame-ink' : 'text-frame-muted hover:bg-frame-hover hover:text-frame-ink'
            }`}
          >
            {tab === t && <span aria-hidden className="absolute inset-y-2 -left-3 w-1 rounded-r bg-clip" />}
            <Icon aria-hidden className={`size-[18px] ${tab === t ? 'text-clip' : ''}`} />
            {label}
            {t === 'clipboard' && status && <span className="ml-auto text-xs font-normal text-frame-muted tabular-nums">{status.items}</span>}
          </button>
        ))}
        <div className="mt-auto space-y-1">
          <UpdateNotice client={window.clipply.updates} variant="sidebar" />
          {status && (
            <button
              type="button"
              onClick={() => void window.clipply.updateSettings({ monitoring: !status.monitoring }).then(refresh)}
              title={status.monitoring ? 'Pause watching the clipboard' : 'Resume watching the clipboard'}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-xs text-frame-muted hover:bg-frame-hover hover:text-frame-ink"
            >
              <span aria-hidden className={`size-2 shrink-0 rounded-full ${status.monitoring ? 'bg-clip' : 'bg-frame-muted'}`} />
              <span className="flex-1">{status.monitoring ? 'Watching the clipboard' : 'Paused'}</span>
              {status.monitoring ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
            </button>
          )}
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {tab === 'clipboard' && <HistoryScreen base={{}} empty="Nothing copied yet. Copy something anywhere and it lands here." />}
        {tab === 'favorites' && <HistoryScreen base={{ favorite: true }} empty="Star a clip to keep it here for quick access." />}
        {tab === 'pinned' && <HistoryScreen base={{ pinned: true }} empty="Pin a clip to keep it at hand. Pinned clips are never deleted by cleanup." />}
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
    <div className="mx-auto max-w-3xl space-y-3 px-6 pb-8">
      <SearchStrip query={query} onQuery={setQuery} kinds={kinds} onKinds={setKinds} inputRef={searchRef} action={<SyncButton account={window.clipply.account} />} />
      <ClipList filter={filter} onOpen={setOpen} emptyText={empty} deviceNames={{}} />
      {open && <ItemViewer item={open} onClose={() => setOpen(null)} />}
      {Object.keys(base).length === 0 && <AddClip />}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import logo from './logo.png';
import { Clipboard, Images, Laptop, Pause, Play, Settings as SettingsIcon, Star } from 'lucide-react';
import { AddClip, AppVersion, ClipList, ItemViewer, JoinRequestBanner, MEDIA_KINDS, SearchStrip, SyncButton, UpdateNotice } from '@clipply/ui';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import type { DesktopStatus } from '../../electron/shared/api';
import { DevicesScreen } from './DevicesScreen';
import { SettingsScreen } from './SettingsScreen';
import { VaultProblem } from './VaultProblem';

type Tab = 'clipboard' | 'favorites' | 'media' | 'devices' | 'settings';

const NAV: Array<{ tab: Tab; label: string; icon: typeof Clipboard }> = [
  { tab: 'clipboard', label: 'Clipboard', icon: Clipboard },
  { tab: 'favorites', label: 'Favorites', icon: Star },
  { tab: 'media', label: 'Media', icon: Images },
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
      <nav aria-label="Main" className="flex w-60 shrink-0 flex-col gap-1 bg-hero px-4 py-5 text-frame-ink">
        <div className="mb-6 flex items-center gap-3 px-1">
          <img src={logo} alt="" className="size-11 rounded-2xl shadow-[0_8px_20px_-8px_rgb(0_0_0/0.6)]" />
          <div className="leading-tight">
            <span className="block text-xl font-bold tracking-tight">Clipply</span>
            <AppVersion client={window.clipply.updates} className="text-xs text-frame-muted tabular-nums" />
          </div>
        </div>
        {NAV.map(({ tab: t, label, icon: Icon }) => (
          <button
            key={t}
            type="button"
            aria-current={tab === t ? 'page' : undefined}
            onClick={() => setTab(t)}
            className={`flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-[0.9375rem] transition-colors ${
              tab === t ? 'bg-white/14 font-semibold text-white shadow-[0_6px_16px_-8px_rgb(0_0_0/0.5)] ring-1 ring-white/15' : 'text-frame-muted hover:bg-white/8 hover:text-frame-ink'
            }`}
          >
            <Icon aria-hidden className={`size-4.5 ${tab === t ? 'text-clip' : ''}`} />
            {label}
            {t === 'clipboard' && status && <span className="ml-auto rounded-full bg-white/12 px-2 py-0.5 text-xs font-medium text-frame-ink tabular-nums">{status.items}</span>}
          </button>
        ))}
        <div className="mt-auto space-y-1">
          {status && (
            <button
              type="button"
              onClick={() => void window.clipply.updateSettings({ monitoring: !status.monitoring }).then(refresh)}
              title={status.monitoring ? 'Pause watching the clipboard' : 'Resume watching the clipboard'}
              className="flex w-full items-center gap-2.5 rounded-2xl bg-white/6 px-3.5 py-3 text-left text-xs text-frame-ink ring-1 ring-white/12 hover:bg-white/10"
            >
              <span aria-hidden className={`size-2.5 shrink-0 rounded-full ${status.monitoring ? 'bg-clip shadow-[0_0_10px_var(--color-clip)]' : 'bg-frame-muted'}`} />
              <span className="flex-1">{status.monitoring ? 'Watching the clipboard' : 'Paused'}</span>
              {status.monitoring ? <Pause aria-hidden className="size-4" /> : <Play aria-hidden className="size-4" />}
            </button>
          )}
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="px-6 pt-4 empty:hidden"><UpdateNotice client={window.clipply.updates} /></div>
        {tab !== 'devices' && (
          <div className="px-6 pt-4 empty:hidden"><JoinRequestBanner account={window.clipply.account} onReview={() => setTab('devices')} /></div>
        )}
        {tab === 'clipboard' && <HistoryScreen base={{}} empty="Nothing copied yet. Copy something anywhere and it lands here." />}
        {tab === 'favorites' && <HistoryScreen base={{ favorite: true }} empty="Star a clip to keep it here for quick access." />}
        {tab === 'media' && <HistoryScreen base={{ kinds: MEDIA_KINDS }} grid empty="No images or files yet. Copy an image or add a file and it shows up here." />}
        {tab === 'devices' && <DevicesScreen />}
        {tab === 'settings' && <SettingsScreen status={status} onChanged={refresh} />}
      </main>
    </div>
  );
}

function HistoryScreen({ base, empty, grid }: { base: ListFilter; empty: string; grid?: boolean }) {
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
    <div className="pb-8">
      <SearchStrip query={query} onQuery={setQuery} kinds={kinds} onKinds={setKinds} inputRef={searchRef} action={<SyncButton account={window.clipply.account} />} {...(base.kinds ? { kindOptions: base.kinds } : {})} />
      <div className={`mx-auto px-6 pt-2 ${grid ? 'max-w-6xl' : 'max-w-[calc(48rem+3rem)]'}`}>
        <ClipList filter={filter} onOpen={setOpen} emptyText={empty} deviceNames={{}} layout={grid ? 'grid' : 'list'} />
      </div>
      {open && <ItemViewer item={open} onClose={() => setOpen(null)} />}
      {Object.keys(base).length === 0 && <AddClip />}
    </div>
  );
}

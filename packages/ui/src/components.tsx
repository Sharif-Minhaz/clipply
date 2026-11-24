import { useRef, useState, type ComponentType, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Check, CheckSquare, ChevronLeft, ChevronRight, Code, Copy, Download, File, Maximize2, Image, Link, Pilcrow, ScanText, Search, Square, Star, StarOff, Trash, Type, X, type LucideProps } from 'lucide-react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';
import { htmlToText } from '@clipply/sync-engine/html';

import { useClipply } from './client';
import { isPendingId } from './optimistic';
import { useClipList, useLinkPreview, useThumbUrl } from './hooks';
import { formatBytes, formatRelative } from './time';

export const KIND_LABEL: Record<ClipKind, string> = {
  text: 'Text', url: 'Link', code: 'Code', html: 'Rich text', image: 'Image', file: 'File',
};

export const MEDIA_KINDS: readonly ClipKind[] = ['image', 'file'];

/** Pinning is retired; items pinned by older versions show and behave as favorites. */
export const isFavorite = (meta: ClipView['meta']): boolean => meta.favorite || meta.pinned;

/** Unfavoriting also clears a legacy pin, or the item would stay a favorite. */
const favoriteFlags = (on: boolean): { favorite: boolean; pinned?: false } => (on ? { favorite: true } : { favorite: false, pinned: false });

export const KIND_ICON: Record<ClipKind, ComponentType<LucideProps>> = {
  text: Type, url: Link, code: Code, html: Pilcrow, image: Image, file: File,
};

/** `shortcut`: key hint shown in the empty field (desktop), e.g. "Ctrl F". */
export function SearchBar({ value, onChange, inputRef, shortcut }: { value: string; onChange: (v: string) => void; inputRef?: React.Ref<HTMLInputElement>; shortcut?: string | undefined }) {
  return (
    <label className="flex items-center gap-2.5 rounded-full bg-raised px-4 py-3 shadow-[0_6px_20px_-12px_rgb(8_60_70/0.45)] ring-1 ring-line/70 focus-within:ring-2 focus-within:ring-accent in-data-hero:gap-2 in-data-hero:bg-white/12 in-data-hero:px-3.5 in-data-hero:py-2 in-data-hero:shadow-none in-data-hero:ring-white/20 in-data-hero:backdrop-blur in-data-hero:focus-within:ring-white/70">
      <Search aria-hidden className="size-5 shrink-0 text-muted in-data-hero:size-4.5 in-data-hero:text-white/80" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search clipboard history"
        placeholder="Search your clips"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown') return;
          const first = document.querySelector<HTMLElement>('[data-clip-primary]');
          if (first) {
            e.preventDefault();
            first.focus();
          }
        }}
        className="w-full bg-transparent text-base text-ink placeholder:text-muted focus:outline-none in-data-hero:text-white in-data-hero:placeholder:text-white/75"
      />
      {shortcut && !value && (
        <kbd aria-hidden className="hidden shrink-0 rounded-md px-1.5 py-0.5 font-sans text-xs whitespace-nowrap text-muted ring-1 ring-line sm:inline in-data-hero:text-white/75 in-data-hero:ring-white/30">{shortcut}</kbd>
      )}
    </label>
  );
}

/**
 * Pills on the page; glass pills inside a `data-hero` header. Below `sm` (phones) only the icons show, so the
 * row stays on one line; the label is still the button's accessible name and tooltip.
 */
export function KindFilter({ value, onChange, options }: { value: readonly ClipKind[]; onChange: (v: ClipKind[]) => void; options?: readonly ClipKind[] | undefined }) {
  const toggle = (kind: ClipKind): void =>
    onChange(value.includes(kind) ? value.filter((k) => k !== kind) : [...value, kind]);
  return (
    <div role="group" aria-label="Filter by type" className="grid grid-cols-6 gap-2 sm:flex sm:flex-wrap in-data-hero:gap-1.5">
      {(options ?? (Object.keys(KIND_LABEL) as ClipKind[])).map((kind) => {
        const on = value.includes(kind);
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            title={KIND_LABEL[kind]}
            onClick={() => toggle(kind)}
            className={`flex items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-sm ring-1 transition-colors in-data-hero:py-1.5 ${
              on
                ? 'bg-strip font-semibold text-white ring-strip in-data-hero:bg-white in-data-hero:text-strip in-data-hero:ring-white'
                : 'bg-raised font-medium text-ink ring-line hover:ring-accent/60 in-data-hero:bg-white/10 in-data-hero:text-white in-data-hero:ring-white/15 in-data-hero:hover:bg-white/20'
            }`}
          >
            <Icon aria-hidden className="size-4.5 sm:size-4 in-data-hero:size-4" />
            <span className="max-sm:sr-only">{KIND_LABEL[kind]}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Search and type filters at the top of the page; sticks while the list scrolls.
 * `hero`: the dark gradient header with rounded bottom (phones). Otherwise a light wash (desktop).
 * `heading` sits above the search and scrolls away; the search and filters stay.
 */
export function SearchStrip(props: {
  query: string; onQuery: (v: string) => void; kinds: readonly ClipKind[]; onKinds: (v: ClipKind[]) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Key hint in the empty search field (desktop). */
  searchShortcut?: string;
  /** Shown beside the search field (the sync button). */
  action?: ReactNode;
  hero?: boolean;
  heading?: ReactNode;
  /** Type pills to offer; all kinds by default. */
  kindOptions?: readonly ClipKind[];
}) {
  return (
    <div
      {...(props.hero ? { 'data-hero': '' } : {})}
      className={`sticky z-10 ${
        props.hero
          ? `rounded-b-3xl bg-hero px-3 pt-3 pb-3 text-white shadow-[0_12px_24px_-14px_rgb(8_40_48/0.7)] ${props.heading ? '-top-12' : 'top-0'}`
          : 'top-0 bg-tint px-6 pt-5 pb-4 shadow-[0_12px_16px_-16px_rgb(0_0_0/0.3)]'
      }`}
    >
      <div className={`mx-auto max-w-3xl ${props.hero ? 'space-y-2.5' : 'space-y-3'}`}>
        {/* h-9 + the pt-3 above = the 3rem the hero header sticks above the top (-top-12). */}
        {props.heading && <div className="flex h-9 items-center">{props.heading}</div>}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1"><SearchBar value={props.query} onChange={props.onQuery} shortcut={props.searchShortcut} {...(props.inputRef ? { inputRef: props.inputRef } : {})} /></div>
          {props.action}
        </div>
        <KindFilter value={props.kinds} onChange={props.onKinds} options={props.kindOptions} />
      </div>
    </div>
  );
}

interface CardProps {
  item: ClipView;
  now: number;
  deviceName?: string | undefined;
  /** `scan`: open an image and start copying its text at once (the card's scan button). */
  onOpen?: ((item: ClipView, action?: 'scan') => void) | undefined;
  /** Set while the list is in selection mode: clicking the card toggles it. */
  selected?: boolean | undefined;
  onSelect?: (() => void) | undefined;
  /** Called after a copy started from the keyboard (Enter/Space), e.g. to hide the desktop window for pasting. */
  onPick?: (() => void) | undefined;
}

export function ClipCard({ item, now, deviceName, onOpen, selected, onSelect, onPick }: CardProps) {
  const client = useClipply();
  const { meta } = item;
  const KindIcon = KIND_ICON[meta.kind];
  const thumb = useThumbUrl(item.id, item.hasThumb);
  const link = useLinkPreview(item.id, meta.kind === 'url');
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copied, setCopied] = useState(false);
  const isFile = meta.kind === 'file';
  const fav = isFavorite(meta);
  // Shown optimistically while the add is still being stored; nothing to act on yet.
  const pending = isPendingId(item.id);
  // Files cannot go on the clipboard, so their primary action is Save.
  const primary = async (): Promise<void> => {
    if (isFile) return void (await client.saveFile(item.id));
    // An older synced image may still have to be downloaded first.
    setCopying(true);
    try {
      await client.copy(item.id);
    } finally {
      setCopying(false);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const act = (fn: () => Promise<void>) => async (): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  // `detail` is 0 when Enter/Space (not a pointer) clicked the button.
  const pick = (e: MouseEvent<HTMLButtonElement>): void => {
    const byKeyboard = e.detail === 0;
    void act(async () => {
      await primary();
      if (byKeyboard && !isFile) onPick?.();
    })();
  };

  return (
    <article
      aria-label={`${KIND_LABEL[meta.kind]} item`}
      style={{ '--kind': `var(--color-kind-${meta.kind})` } as CSSProperties}
      className={`@container relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 rounded-2xl bg-raised py-3 pr-3 pl-4 ring-1 transition-shadow max-sm:gap-x-2.5 max-sm:gap-y-1 max-sm:py-2.5 max-sm:pr-2.5 max-sm:pl-3.5 ${
        selected ? 'ring-2 ring-accent' : 'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_10px_24px_-16px_rgb(8_50_60/0.35)] ring-line/60 hover:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_14px_30px_-14px_rgb(8_50_60/0.4)]'
      }`}
    >
      {/* Inset from the corners rather than a border-left, which bends around the radius. */}
      <span aria-hidden className="absolute inset-y-4 left-0 w-1 rounded-r-full bg-(--kind) max-sm:inset-y-3" />
      <span aria-hidden className="flex size-10 items-center justify-center self-start rounded-xl bg-(--kind)/12 text-(--kind) max-sm:size-8 max-sm:rounded-lg sm:row-span-3 sm:size-11">
        <KindIcon className="size-5 max-sm:size-4" />
      </span>
      {/* Sized by the card, not the window (a narrow desktop window still has its sidebar): with a device name and no room, the time gets its own line. */}
      <header className="flex min-w-0 items-center gap-2 text-xs text-muted">
        {onSelect && (selected ? <CheckSquare aria-hidden className="size-4 shrink-0 text-accent" /> : <Square aria-hidden className="size-4 shrink-0" />)}
        <div className={`flex min-w-0 flex-1 gap-x-2 ${deviceName ? 'flex-col @lg:flex-row @lg:items-center' : 'items-center'}`}>
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-semibold text-(--kind)">{KIND_LABEL[meta.kind]}</span>
            {isFavorite(meta) && <Star aria-label="Favorite" className="size-3.5 shrink-0 fill-accent text-accent" />}
            {meta.title && <span className="truncate font-semibold text-ink">{meta.title}</span>}
          </span>
          <span className={deviceName ? 'min-w-0 truncate @lg:ml-auto' : 'ml-auto shrink-0 whitespace-nowrap'}>
            {copying || pending ? (
              <span role="status" className="flex items-center gap-1 font-semibold text-accent">
                <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> {pending ? 'Saving…' : 'Copying…'}
              </span>
            ) : copied ? (
              <span role="status" className="flex items-center gap-1 font-semibold text-accent"><Check aria-hidden className="size-4" /> Copied</span>
            ) : (
              <>
                <time dateTime={new Date(meta.createdAt).toISOString()}>{formatRelative(meta.createdAt, now)}</time>
                {deviceName && <span title={`Copied on ${deviceName}`}>, from {deviceName}</span>}
              </>
            )}
          </span>
        </div>
        {onOpen && !onSelect && !pending && <span className="-my-1"><IconButton icon={Maximize2} label="Expand" onClick={() => onOpen(item)} /></span>}
      </header>

      <button
        type="button"
        data-clip-primary
        onClick={onSelect ?? pick}
        disabled={(busy || pending) && !onSelect}
        {...(onSelect ? { 'aria-pressed': !!selected } : {})}
        title={onSelect ? undefined : isFile ? 'Click to save' : 'Click to copy'}
        aria-label={`${onSelect ? 'Select' : isFile ? 'Save' : 'Copy'} ${KIND_LABEL[meta.kind].toLowerCase()} item`}
        className="col-span-2 block w-full min-w-0 cursor-pointer scroll-mt-48 scroll-mb-6 rounded-lg py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent disabled:cursor-default sm:col-span-1 sm:col-start-2"
      >
        {meta.kind === 'image' ? (
          thumb ? (
            <img src={thumb} alt={meta.title ?? 'Clipboard image'} className="max-h-48 rounded-lg border border-line object-contain max-sm:max-h-36" />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-lg bg-surface text-sm text-muted">Image</div>
          )
        ) : meta.kind === 'url' ? (
          <div className="space-y-2">
            <p className="line-clamp-2 break-words text-[1.0625rem] leading-relaxed text-(--kind) max-sm:text-[0.9375rem] max-sm:leading-snug underline decoration-(--kind)/40 underline-offset-2">{item.preview}</p>
            {(link.imageUrl || link.title) && (
              <div className="overflow-hidden rounded-lg border border-line bg-surface">
                {link.imageUrl && <img src={link.imageUrl} alt="" loading="lazy" className="max-h-56 w-full object-cover" />}
                {link.title && <p className="line-clamp-2 px-3 py-2 text-sm font-semibold text-ink">{link.title}</p>}
              </div>
            )}
          </div>
        ) : (
          <p className={`line-clamp-4 break-words whitespace-pre-wrap text-ink max-sm:line-clamp-3 ${meta.kind === 'code' ? 'font-mono text-[0.84rem] leading-relaxed max-sm:text-[0.78rem] max-sm:leading-normal' : 'text-[1.0625rem] leading-relaxed max-sm:text-[0.9375rem] max-sm:leading-snug'}`}>
            {item.preview}
          </p>
        )}
      </button>

      {!onSelect && !pending && <footer className="col-span-2 -ml-2 flex items-center gap-0.5 sm:col-span-1 sm:col-start-2">
        {meta.kind === 'image' && <IconButton icon={Download} label="Save" disabled={busy} onClick={act(async () => void (await client.saveFile(item.id)))} />}
        {meta.kind === 'image' && onOpen && <IconButton icon={ScanText} label="Copy text from image" disabled={busy} onClick={() => onOpen(item, 'scan')} />}
        <IconButton icon={Star} label={fav ? 'Unfavorite' : 'Favorite'} pressed={fav} disabled={busy} onClick={act(() => client.setFlags(item.id, favoriteFlags(!fav)))} />
        <IconButton icon={Trash} label="Delete" danger disabled={busy} onClick={act(() => client.remove([item.id]))} />
        <button
          type="button"
          disabled={busy}
          onClick={pick}
          className="ml-auto flex items-center gap-1.5 rounded-full bg-(--kind)/12 px-4 py-2 text-sm font-semibold max-sm:gap-1 max-sm:px-3 max-sm:py-1.5 max-sm:text-[0.8125rem] text-(--kind) transition-colors hover:bg-(--kind)/20 disabled:opacity-50"
        >
          {isFile ? <Download aria-hidden className="size-4 max-sm:size-3.5" /> : <Copy aria-hidden className="size-4 max-sm:size-3.5" />}
          {isFile ? 'Save' : 'Copy'}
        </button>
      </footer>}
    </article>
  );
}

export function IconButton(props: {
  icon: ComponentType<LucideProps>;
  label: string;
  onClick: () => void;
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      title={props.label}
      aria-label={props.label}
      onClick={props.onClick}
      disabled={props.disabled}
      {...(props.pressed !== undefined ? { 'aria-pressed': props.pressed } : {})}
      className={`flex size-9 items-center justify-center rounded-full transition-colors hover:bg-surface max-sm:size-8 disabled:opacity-50 ${
        props.danger ? 'text-muted hover:text-danger' : props.pressed ? 'text-accent' : 'text-muted hover:text-ink'
      }`}
    >
      <Icon aria-hidden className={`size-4.5 max-sm:size-4 ${props.pressed ? 'fill-current' : ''}`} />
    </button>
  );
}

const TEXT_KINDS: ReadonlySet<ClipKind> = new Set(['text', 'url', 'code', 'html']);

/**
 * Arrow keys move between clips (Up from the first one returns to the search field); Enter/Space then
 * act on the focused clip, as its main button does. In the grid, Left/Right step and Up/Down skip a row.
 */
function moveFocus(e: KeyboardEvent<HTMLElement>, grid: boolean): void {
  if (e.altKey || e.ctrlKey || e.metaKey || !['ArrowDown', 'ArrowUp', ...(grid ? ['ArrowLeft', 'ArrowRight'] : [])].includes(e.key)) return;
  const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-clip-primary]')];
  const at = all.findIndex((el) => el.closest('li')?.contains(document.activeElement));
  if (at < 0) return;
  e.preventDefault();
  const rowTop = (el: HTMLElement): number => el.closest('li')!.offsetTop;
  const cols = grid ? Math.max(1, all.filter((el) => rowTop(el) === rowTop(all[0]!)).length) : 1;
  const step = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -cols : cols;
  const next = at + step;
  if (next < 0) document.querySelector<HTMLElement>('input[type="search"]')?.focus();
  else all[Math.min(next, all.length - 1)]?.focus();
}

export function ClipList(props: {
  filter: ListFilter;
  deviceNames?: Record<string, string>;
  now?: number;
  onOpen?: (item: ClipView, action?: 'scan') => void;
  emptyText?: string;
  /** `grid`: a gallery of tiles (the Media tab). */
  layout?: 'list' | 'grid';
  /** See ClipCard `onPick`. */
  onPick?: () => void;
  /** Clips per page; only that page is fetched from the platform. */
  pageSize?: number;
}) {
  const { filter, deviceNames = {}, now = Date.now(), onOpen, layout = 'list', onPick, pageSize = 100 } = props;
  const client = useClipply();
  const [page, setPage] = useState(0);
  // A new search or filter starts again at the first page.
  const filterKey = JSON.stringify(filter);
  const [pageFor, setPageFor] = useState(filterKey);
  if (pageFor !== filterKey) {
    setPageFor(filterKey);
    setPage(0);
  }
  const { items, total, error } = useClipList({ ...filter, offset: page * pageSize, limit: pageSize });
  const listRef = useRef<HTMLDivElement>(null);
  // null = normal mode; a set = selection mode (bulk favorite / unfavorite / delete).
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  // Deleting the last clips of the last page moves back to the page that still has some.
  if (items && page > 0 && page >= pages) setPage(pages - 1);
  const goTo = (p: number): void => {
    setPage(p);
    setSelected((s) => (s ? new Set() : s));
    listRef.current?.closest('main')?.scrollTo({ top: 0 });
  };
  if (error) return <p role="alert" className="p-4 text-sm text-danger">Could not load history: {error.message}</p>;
  if (!items) {
    return (
      <div aria-busy="true" className="space-y-2">
        {layout === 'grid' ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <div key={i} className="aspect-square animate-pulse rounded-2xl bg-raised" />)}
          </div>
        ) : (
          [0, 1, 2].map((i) => <div key={i} className="h-28 animate-pulse rounded-2xl bg-raised" />)
        )}
      </div>
    );
  }
  if (items.length === 0 && page === 0) {
    return <p className="mx-auto max-w-sm py-16 text-center text-base text-muted">{filter.query ? `Nothing matches “${filter.query}”.` : props.emptyText ?? 'Nothing copied yet.'}</p>;
  }
  const visible = selected ? [...selected].filter((id) => items.some((i) => i.id === id)) : [];
  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const bulk = (fn: (ids: string[]) => Promise<unknown>) => (): void => void fn(visible).then(() => setSelected(null));
  const textIds = visible.filter((id) => TEXT_KINDS.has(items.find((i) => i.id === id)!.meta.kind));
  // In the order they were picked, one per line; images and files are left out.
  const copySelected = async (ids: string[]): Promise<void> => {
    const texts: string[] = [];
    for (const id of ids) {
      const body = new TextDecoder().decode(await client.readBody(id));
      texts.push(items.find((i) => i.id === id)?.meta.kind === 'html' ? htmlToText(body) : body.trimEnd());
    }
    await client.copyText(texts.join('\n'));
  };
  return (
    <div ref={listRef} className="space-y-2" onKeyDown={(e) => moveFocus(e, layout === 'grid')}>
      <div role="toolbar" aria-label="Selection" className="flex min-h-9 flex-wrap items-center gap-1 text-sm text-muted">
        {selected ? (
          <>
            <span className="mr-auto font-semibold text-ink">{visible.length} selected</span>
            <IconButton icon={CheckSquare} label={pages > 1 ? 'Select all on this page' : 'Select all'} onClick={() => setSelected(new Set(items.map((i) => i.id)))} />
            <IconButton icon={Copy} label={`Copy ${textIds.length} as text`} disabled={!textIds.length} onClick={bulk(() => copySelected(textIds))} />
            <IconButton icon={Star} label="Favorite selected" disabled={!visible.length} onClick={bulk((ids) => Promise.all(ids.map((id) => client.setFlags(id, favoriteFlags(true)))))} />
            <IconButton icon={StarOff} label="Unfavorite selected" disabled={!visible.length} onClick={bulk((ids) => Promise.all(ids.map((id) => client.setFlags(id, favoriteFlags(false)))))} />
            <IconButton
              icon={Trash}
              label="Delete selected"
              danger
              disabled={!visible.length}
              onClick={() => window.confirm(`Delete ${visible.length} item${visible.length === 1 ? '' : 's'}?`) && bulk((ids) => client.remove(ids))()}
            />
            <IconButton icon={X} label="Cancel selection" onClick={() => setSelected(null)} />
          </>
        ) : (
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded-full bg-raised px-3.5 py-1.5 font-medium ring-1 ring-line hover:text-ink">Select</button>
        )}
      </div>
      {layout === 'grid' ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((item) => (
            <li key={item.id}>
              <MediaTile item={item} now={now} deviceName={deviceNames[item.meta.originDeviceId]} onOpen={onOpen} {...(selected ? { selected: selected.has(item.id), onSelect: () => toggle(item.id) } : {})} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-3 max-sm:space-y-2.5">
          {items.map((item) => (
            <li key={item.id}>
              <ClipCard
                item={item} now={now} deviceName={deviceNames[item.meta.originDeviceId]} onOpen={onOpen} onPick={onPick}
                {...(selected ? { selected: selected.has(item.id), onSelect: () => toggle(item.id) } : {})}
              />
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap items-center justify-center gap-2 pt-3 text-sm text-muted">
          <button type="button" disabled={page === 0} onClick={() => goTo(page - 1)} className="flex items-center gap-1 rounded-full bg-raised py-1.5 pr-3.5 pl-2.5 font-medium ring-1 ring-line hover:text-ink disabled:opacity-40">
            <ChevronLeft aria-hidden className="size-4" /> Previous
          </button>
          <span aria-live="polite" className="px-1 tabular-nums">
            {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total}
          </span>
          <button type="button" disabled={page >= pages - 1} onClick={() => goTo(page + 1)} className="flex items-center gap-1 rounded-full bg-raised py-1.5 pr-2.5 pl-3.5 font-medium ring-1 ring-line hover:text-ink disabled:opacity-40">
            Next <ChevronRight aria-hidden className="size-4" />
          </button>
        </nav>
      )}
    </div>
  );
}

/**
 * One gallery tile: the image thumbnail, or a file's icon, name and size, with copy (images), download,
 * favorite and delete. Delete is the same library removal as the list, so the clip also leaves the
 * Clipboard tab and the deletion syncs to other devices. Clicking the preview opens the viewer.
 */
export function MediaTile({ item, now, deviceName, onOpen, selected, onSelect }: CardProps) {
  const client = useClipply();
  const { meta } = item;
  const isFile = meta.kind === 'file';
  const thumb = useThumbUrl(item.id, !isFile && item.hasThumb);
  const fav = isFavorite(meta);
  const name = isFile ? meta.file?.name ?? 'File' : meta.title ?? 'Image';
  const KindIcon = KIND_ICON[meta.kind];
  const pending = isPendingId(item.id);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const act = (fn: () => Promise<void>) => async (): Promise<void> => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const copy = act(async () => {
    await client.copy(item.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  });
  const open = (): void => {
    if (onOpen) return onOpen(item);
    void (isFile ? client.saveFile(item.id) : copy());
  };

  return (
    <article
      aria-label={`${KIND_LABEL[meta.kind]} item`}
      style={{ '--kind': `var(--color-kind-${meta.kind})` } as CSSProperties}
      className={`relative overflow-hidden rounded-2xl bg-raised ring-1 transition-shadow ${
        selected ? 'ring-2 ring-accent' : 'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_10px_24px_-16px_rgb(8_50_60/0.35)] ring-line/60 hover:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_14px_30px_-14px_rgb(8_50_60/0.4)]'
      }`}
    >
      <button
        type="button"
        onClick={onSelect ?? open}
        disabled={pending && !onSelect}
        {...(onSelect ? { 'aria-pressed': !!selected } : {})}
        data-clip-primary
        aria-label={`${onSelect ? 'Select' : 'Open'} ${name}`}
        title={name}
        className="block w-full cursor-pointer scroll-mt-48 scroll-mb-6 rounded-t-2xl text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      >
        <div className="flex aspect-square items-center justify-center bg-surface">
          {thumb ? (
            <img src={thumb} alt={meta.title ?? 'Clipboard image'} loading="lazy" className="size-full object-cover" />
          ) : (
            <span aria-hidden className="flex size-14 items-center justify-center rounded-2xl bg-(--kind)/12 text-(--kind)">
              <KindIcon className="size-7" />
            </span>
          )}
        </div>
        <div className="space-y-0.5 px-3 pt-2">
          <p className="truncate text-sm font-semibold text-ink">{name}</p>
          <p className="truncate text-xs text-muted">
            {pending ? (
              <span role="status" className="font-semibold text-accent">Saving…</span>
            ) : copied ? (
              <span role="status" className="font-semibold text-accent">Copied</span>
            ) : (
              <>{formatBytes(meta.size)} · <time dateTime={new Date(meta.createdAt).toISOString()}>{formatRelative(meta.createdAt, now)}</time></>
            )}
          </p>
          {deviceName && <p className="truncate text-xs text-muted" title={`Copied on ${deviceName}`}>from {deviceName}</p>}
        </div>
      </button>
      {onSelect ? (
        <span aria-hidden className="pointer-events-none absolute top-2 left-2 rounded-md bg-raised/90 p-0.5">
          {selected ? <CheckSquare className="size-4 text-accent" /> : <Square className="size-4 text-muted" />}
        </span>
      ) : pending ? (
        <div aria-hidden className="h-10" />
      ) : (
        <footer className="flex items-center gap-0.5 px-1 pb-1">
          {!isFile && <IconButton icon={Copy} label="Copy" disabled={busy} onClick={() => void copy()} />}
          <IconButton icon={Download} label="Download" disabled={busy} onClick={act(async () => void (await client.saveFile(item.id)))} />
          <IconButton icon={Star} label={fav ? 'Unfavorite' : 'Favorite'} pressed={fav} disabled={busy} onClick={act(() => client.setFlags(item.id, favoriteFlags(!fav)))} />
          <span className="ml-auto"><IconButton icon={Trash} label="Delete" danger disabled={busy} onClick={act(() => client.remove([item.id]))} /></span>
        </footer>
      )}
    </article>
  );
}

import { useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { Check, CheckSquare, Code, Copy, Download, File, Maximize2, Image, Link, Pilcrow, Search, Square, Star, StarOff, Trash, Type, X, type LucideProps } from 'lucide-react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { useClipply } from './client';
import { isPendingId } from './optimistic';
import { useClipList, useLinkPreview, useThumbUrl } from './hooks';
import { formatRelative } from './time';
import { formatBytes } from './viewer';

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

export function SearchBar({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <label className="flex items-center gap-2.5 rounded-full bg-raised px-4 py-3 shadow-[0_6px_20px_-12px_rgb(8_60_70/0.45)] ring-1 ring-line/70 focus-within:ring-2 focus-within:ring-accent in-data-hero:bg-white/12 in-data-hero:shadow-none in-data-hero:ring-white/20 in-data-hero:backdrop-blur in-data-hero:focus-within:ring-white/70">
      <Search aria-hidden className="size-5 shrink-0 text-muted in-data-hero:text-white/80" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search clipboard history"
        placeholder="Search your clips"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-base text-ink placeholder:text-muted focus:outline-none in-data-hero:text-white in-data-hero:placeholder:text-white/75"
      />
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
    <div role="group" aria-label="Filter by type" className="grid grid-cols-6 gap-2 sm:flex sm:flex-wrap">
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
            className={`flex items-center justify-center gap-1.5 rounded-full px-3.5 py-2 text-sm ring-1 transition-colors ${
              on
                ? 'bg-strip font-semibold text-white ring-strip in-data-hero:bg-white in-data-hero:text-strip in-data-hero:ring-white'
                : 'bg-raised font-medium text-ink ring-line hover:ring-accent/60 in-data-hero:bg-white/10 in-data-hero:text-white in-data-hero:ring-white/15 in-data-hero:hover:bg-white/20'
            }`}
          >
            <Icon aria-hidden className="size-4.5 sm:size-4" />
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
          ? `rounded-b-[2rem] bg-hero px-4 pt-4 pb-5 text-white shadow-[0_14px_30px_-16px_rgb(8_40_48/0.7)] ${props.heading ? '-top-16' : 'top-0'}`
          : 'top-0 bg-tint px-6 pt-5 pb-4 shadow-[0_12px_16px_-16px_rgb(0_0_0/0.3)]'
      }`}
    >
      <div className="mx-auto max-w-3xl space-y-3">
        {/* h-12 + the pt-4 above = the 4rem the header sticks above the top (-top-16). */}
        {props.heading && <div className="flex h-12 items-center">{props.heading}</div>}
        <div className="flex gap-2">
          <div className="min-w-0 flex-1"><SearchBar value={props.query} onChange={props.onQuery} {...(props.inputRef ? { inputRef: props.inputRef } : {})} /></div>
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
  onOpen?: ((item: ClipView) => void) | undefined;
  /** Set while the list is in selection mode: clicking the card toggles it. */
  selected?: boolean | undefined;
  onSelect?: (() => void) | undefined;
}

export function ClipCard({ item, now, deviceName, onOpen, selected, onSelect }: CardProps) {
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

  return (
    <article
      aria-label={`${KIND_LABEL[meta.kind]} item`}
      style={{ '--kind': `var(--color-kind-${meta.kind})` } as CSSProperties}
      className={`relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 rounded-2xl bg-raised py-3 pr-3 pl-4 ring-1 transition-shadow ${
        selected ? 'ring-2 ring-accent' : 'shadow-[0_1px_2px_rgb(0_0_0/0.04),0_10px_24px_-16px_rgb(8_50_60/0.35)] ring-line/60 hover:shadow-[0_1px_2px_rgb(0_0_0/0.05),0_14px_30px_-14px_rgb(8_50_60/0.4)]'
      }`}
    >
      {/* Inset from the corners rather than a border-left, which bends around the radius. */}
      <span aria-hidden className="absolute inset-y-4 left-0 w-1 rounded-r-full bg-(--kind)" />
      <span aria-hidden className="flex size-10 items-center justify-center self-start rounded-xl bg-(--kind)/12 text-(--kind) sm:row-span-3 sm:size-11">
        <KindIcon className="size-5" />
      </span>
      <header className="flex min-w-0 items-center gap-2 text-xs text-muted">
        {onSelect && (selected ? <CheckSquare aria-hidden className="size-4 text-accent" /> : <Square aria-hidden className="size-4" />)}
        <span className="text-sm font-semibold text-(--kind)">{KIND_LABEL[meta.kind]}</span>
        {isFavorite(meta) && <Star aria-label="Favorite" className="size-3.5 fill-accent text-accent" />}
        {meta.title && <span className="truncate font-semibold text-ink">{meta.title}</span>}
        <span className="ml-auto whitespace-nowrap">
          {copying || pending ? (
            <span role="status" className="flex items-center gap-1 font-semibold text-accent">
              <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> {pending ? 'Saving…' : 'Copying…'}
            </span>
          ) : copied ? (
            <span role="status" className="flex items-center gap-1 font-semibold text-accent"><Check aria-hidden className="size-4" /> Copied</span>
          ) : (
            <>
              <time dateTime={new Date(meta.createdAt).toISOString()}>{formatRelative(meta.createdAt, now)}</time>
              {deviceName && <span>, from {deviceName}</span>}
            </>
          )}
        </span>
        {onOpen && !onSelect && !pending && <span className="-my-1"><IconButton icon={Maximize2} label="Expand" onClick={() => onOpen(item)} /></span>}
      </header>

      <button
        type="button"
        onClick={onSelect ?? act(primary)}
        disabled={(busy || pending) && !onSelect}
        {...(onSelect ? { 'aria-pressed': !!selected } : {})}
        title={onSelect ? undefined : isFile ? 'Click to save' : 'Click to copy'}
        aria-label={`${onSelect ? 'Select' : isFile ? 'Save' : 'Copy'} ${KIND_LABEL[meta.kind].toLowerCase()} item`}
        className="col-span-2 block w-full cursor-pointer rounded-lg py-1 text-left disabled:cursor-default sm:col-span-1 sm:col-start-2"
      >
        {meta.kind === 'image' ? (
          thumb ? (
            <img src={thumb} alt={meta.title ?? 'Clipboard image'} className="max-h-48 rounded-lg border border-line object-contain" />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-lg bg-surface text-sm text-muted">Image</div>
          )
        ) : meta.kind === 'url' ? (
          <div className="space-y-2">
            <p className="line-clamp-2 break-words text-[1.0625rem] leading-relaxed text-(--kind) underline decoration-(--kind)/40 underline-offset-2">{item.preview}</p>
            {(link.imageUrl || link.title) && (
              <div className="overflow-hidden rounded-lg border border-line bg-surface">
                {link.imageUrl && <img src={link.imageUrl} alt="" loading="lazy" className="max-h-56 w-full object-cover" />}
                {link.title && <p className="line-clamp-2 px-3 py-2 text-sm font-semibold text-ink">{link.title}</p>}
              </div>
            )}
          </div>
        ) : (
          <p className={`line-clamp-4 break-words whitespace-pre-wrap text-ink ${meta.kind === 'code' ? 'font-mono text-[0.84rem] leading-relaxed' : 'text-[1.0625rem] leading-relaxed'}`}>
            {item.preview}
          </p>
        )}
      </button>

      {!onSelect && !pending && <footer className="col-span-2 -ml-2 flex items-center gap-0.5 sm:col-span-1 sm:col-start-2">
        {meta.kind === 'image' && <IconButton icon={Download} label="Save" disabled={busy} onClick={act(async () => void (await client.saveFile(item.id)))} />}
        <IconButton icon={Star} label={fav ? 'Unfavorite' : 'Favorite'} pressed={fav} disabled={busy} onClick={act(() => client.setFlags(item.id, favoriteFlags(!fav)))} />
        <IconButton icon={Trash} label="Delete" danger disabled={busy} onClick={act(() => client.remove([item.id]))} />
        <button
          type="button"
          disabled={busy}
          onClick={act(primary)}
          className="ml-auto flex items-center gap-1.5 rounded-full bg-(--kind)/12 px-4 py-2 text-sm font-semibold text-(--kind) transition-colors hover:bg-(--kind)/20 disabled:opacity-50"
        >
          {isFile ? <Download aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
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
      className={`flex size-9 items-center justify-center rounded-full transition-colors hover:bg-surface disabled:opacity-50 ${
        props.danger ? 'text-muted hover:text-danger' : props.pressed ? 'text-accent' : 'text-muted hover:text-ink'
      }`}
    >
      <Icon aria-hidden className={`size-4.5 ${props.pressed ? 'fill-current' : ''}`} />
    </button>
  );
}

export function ClipList(props: {
  filter: ListFilter;
  deviceNames?: Record<string, string>;
  now?: number;
  onOpen?: (item: ClipView) => void;
  emptyText?: string;
  /** `grid`: a gallery of tiles (the Media tab). */
  layout?: 'list' | 'grid';
}) {
  const { filter, deviceNames = {}, now = Date.now(), onOpen, layout = 'list' } = props;
  const client = useClipply();
  const { items, error } = useClipList(filter);
  // null = normal mode; a set = selection mode (bulk favorite / unfavorite / delete).
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
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
  if (items.length === 0) {
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
  return (
    <div className="space-y-2">
      <div role="toolbar" aria-label="Selection" className="flex min-h-9 items-center gap-1 text-sm text-muted">
        {selected ? (
          <>
            <span className="mr-auto font-semibold text-ink">{visible.length} selected</span>
            <IconButton icon={CheckSquare} label="Select all" onClick={() => setSelected(new Set(items.map((i) => i.id)))} />
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
              <MediaTile item={item} now={now} onOpen={onOpen} {...(selected ? { selected: selected.has(item.id), onSelect: () => toggle(item.id) } : {})} />
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item.id}>
              <ClipCard
                item={item} now={now} deviceName={deviceNames[item.meta.originDeviceId]} onOpen={onOpen}
                {...(selected ? { selected: selected.has(item.id), onSelect: () => toggle(item.id) } : {})}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * One gallery tile: the image thumbnail, or a file's icon, name and size, with copy (images), download,
 * favorite and delete. Delete is the same library removal as the list, so the clip also leaves the
 * Clipboard tab and the deletion syncs to other devices. Clicking the preview opens the viewer.
 */
export function MediaTile({ item, now, onOpen, selected, onSelect }: Omit<CardProps, 'deviceName'>) {
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
        aria-label={`${onSelect ? 'Select' : 'Open'} ${name}`}
        title={name}
        className="block w-full cursor-pointer text-left"
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

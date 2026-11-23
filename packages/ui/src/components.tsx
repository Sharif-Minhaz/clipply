import { useState, type ComponentType } from 'react';
import { Check, CheckSquare, Code, Copy, Download, File, Maximize2, Image, Link, Pin, PinOff, Search, Square, Star, Trash, Type, X, type LucideProps } from 'lucide-react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { useClipply } from './client';
import { useClipList, useLinkPreview, useThumbUrl } from './hooks';
import { formatRelative } from './time';

export const KIND_LABEL: Record<ClipKind, string> = {
  text: 'Text', url: 'Link', code: 'Code', html: 'Rich text', image: 'Image', file: 'File',
};

export const KIND_ICON: Record<ClipKind, ComponentType<LucideProps>> = {
  text: Type, url: Link, code: Code, html: Type, image: Image, file: File,
};

export function SearchBar({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <label className="flex items-center gap-2.5 rounded-lg bg-raised px-3.5 py-2.5 shadow-[0_1px_0_rgb(0_0_0/0.12)] focus-within:outline-2 focus-within:outline-white">
      <Search aria-hidden className="size-[18px] shrink-0 text-muted" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search clipboard history"
        placeholder="Search your clips"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-base text-ink placeholder:text-muted focus:outline-none"
      />
    </label>
  );
}

/** The chips sit on the teal strip, so they are white on teal rather than page colors. */
export function KindFilter({ value, onChange }: { value: readonly ClipKind[]; onChange: (v: ClipKind[]) => void }) {
  const toggle = (kind: ClipKind): void =>
    onChange(value.includes(kind) ? value.filter((k) => k !== kind) : [...value, kind]);
  return (
    <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-1.5">
      {(Object.keys(KIND_LABEL) as ClipKind[]).map((kind) => {
        const on = value.includes(kind);
        const Icon = KIND_ICON[kind];
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(kind)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm transition-colors ${
              on ? 'bg-white font-semibold text-strip' : 'font-medium text-white hover:bg-strip-hover'
            }`}
          >
            <Icon aria-hidden className="size-3.5" />
            {KIND_LABEL[kind]}
          </button>
        );
      })}
    </div>
  );
}

/** The teal clip at the top of the page: search and type filters. Sticks while the list scrolls. */
export function SearchStrip(props: {
  query: string; onQuery: (v: string) => void; kinds: readonly ClipKind[]; onKinds: (v: ClipKind[]) => void;
  inputRef?: React.Ref<HTMLInputElement>;
  /** Shown beside the search field (the sync button). */
  action?: React.ReactNode;
}) {
  return (
    <div className="sticky top-0 z-10 space-y-2.5 rounded-b-2xl bg-strip px-4 pt-4 pb-3">
      <div className="flex gap-2">
        <div className="min-w-0 flex-1"><SearchBar value={props.query} onChange={props.onQuery} {...(props.inputRef ? { inputRef: props.inputRef } : {})} /></div>
        {props.action}
      </div>
      <KindFilter value={props.kinds} onChange={props.onKinds} />
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
      className={`group rounded-xl border bg-raised transition-colors ${selected ? 'border-accent ring-2 ring-accent/30' : 'border-line hover:border-muted/50'}`}
    >
      <header className="flex items-center gap-2 px-4 pt-3 text-xs text-muted">
        {onSelect && (selected ? <CheckSquare aria-hidden className="size-4 text-accent" /> : <Square aria-hidden className="size-4" />)}
        <KindIcon aria-hidden className="size-4" />
        <span className="font-semibold">{KIND_LABEL[meta.kind]}</span>
        {meta.pinned && <Pin aria-label="Pinned" className="size-3.5 fill-accent text-accent" />}
        {meta.favorite && <Star aria-label="Favorite" className="size-3.5 fill-accent text-accent" />}
        {meta.title && <span className="truncate font-semibold text-ink">{meta.title}</span>}
        <span className="ml-auto whitespace-nowrap">
          {copying ? (
            <span role="status" className="flex items-center gap-1 font-semibold text-accent">
              <span aria-hidden className="size-3.5 animate-spin rounded-full border-2 border-accent border-t-transparent" /> Copying…
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
      </header>

      <button
        type="button"
        onClick={onSelect ?? act(primary)}
        disabled={busy && !onSelect}
        {...(onSelect ? { 'aria-pressed': !!selected } : {})}
        title={onSelect ? undefined : isFile ? 'Click to save' : 'Click to copy'}
        aria-label={`${onSelect ? 'Select' : isFile ? 'Save' : 'Copy'} ${KIND_LABEL[meta.kind].toLowerCase()} item`}
        className="block w-full cursor-pointer px-4 py-2 text-left disabled:cursor-default"
      >
        {meta.kind === 'image' ? (
          thumb ? (
            <img src={thumb} alt={meta.title ?? 'Clipboard image'} className="max-h-48 rounded-lg border border-line object-contain" />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-lg bg-surface text-sm text-muted">Image</div>
          )
        ) : meta.kind === 'url' ? (
          <div className="space-y-2">
            <p className="line-clamp-2 break-words text-[1.0625rem] leading-relaxed text-accent underline decoration-accent/40 underline-offset-2">{item.preview}</p>
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

      {!onSelect && <footer className="flex items-center gap-0.5 px-2 pb-2">
        <IconButton icon={isFile ? Download : Copy} label={isFile ? 'Save' : 'Copy'} disabled={busy} onClick={act(primary)} />
        {meta.kind === 'image' && <IconButton icon={Download} label="Save" disabled={busy} onClick={act(async () => void (await client.saveFile(item.id)))} />}
        <IconButton icon={Pin} label={meta.pinned ? 'Unpin' : 'Pin'} pressed={meta.pinned} disabled={busy} onClick={act(() => client.setFlags(item.id, { pinned: !meta.pinned }))} />
        <IconButton icon={Star} label={meta.favorite ? 'Unfavorite' : 'Favorite'} pressed={meta.favorite} disabled={busy} onClick={act(() => client.setFlags(item.id, { favorite: !meta.favorite }))} />
        <IconButton icon={Trash} label="Delete" danger disabled={busy} onClick={act(() => client.remove([item.id]))} />
        {onOpen && <span className="ml-auto"><IconButton icon={Maximize2} label="Expand" onClick={() => onOpen(item)} /></span>}
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
      className={`flex size-8 items-center justify-center rounded-md transition-colors hover:bg-surface disabled:opacity-50 ${
        props.danger ? 'text-muted hover:text-danger' : props.pressed ? 'text-accent' : 'text-muted hover:text-ink'
      }`}
    >
      <Icon aria-hidden className={`size-4 ${props.pressed ? 'fill-current' : ''}`} />
    </button>
  );
}

export function ClipList(props: {
  filter: ListFilter;
  deviceNames?: Record<string, string>;
  now?: number;
  onOpen?: (item: ClipView) => void;
  emptyText?: string;
}) {
  const { filter, deviceNames = {}, now = Date.now(), onOpen } = props;
  const client = useClipply();
  const { items, error } = useClipList(filter);
  // null = normal mode; a set = selection mode (bulk pin / unpin / delete).
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(null);
  if (error) return <p role="alert" className="p-4 text-sm text-danger">Could not load history: {error.message}</p>;
  if (!items) {
    return (
      <div aria-busy="true" className="space-y-2">
        {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-raised" />)}
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
            <IconButton icon={Pin} label="Pin selected" disabled={!visible.length} onClick={bulk((ids) => Promise.all(ids.map((id) => client.setFlags(id, { pinned: true }))))} />
            <IconButton icon={PinOff} label="Unpin selected" disabled={!visible.length} onClick={bulk((ids) => Promise.all(ids.map((id) => client.setFlags(id, { pinned: false }))))} />
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
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded-md px-2.5 py-1 hover:bg-raised hover:text-ink">Select</button>
        )}
      </div>
      <ul className="space-y-2.5">
        {items.map((item) => (
          <li key={item.id}>
            <ClipCard
              item={item} now={now} deviceName={deviceNames[item.meta.originDeviceId]} onOpen={onOpen}
              {...(selected ? { selected: selected.has(item.id), onSelect: () => toggle(item.id) } : {})}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

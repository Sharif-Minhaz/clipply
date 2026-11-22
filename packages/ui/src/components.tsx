import { useState, type ComponentType } from 'react';
import { CheckSquare, Code, Copy, Download, File, Image, Link, Pin, PinOff, Search, Square, Star, Trash, Type, X, type LucideProps } from 'lucide-react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { useClipply } from './client';
import { useClipList, useThumbUrl } from './hooks';
import { formatRelative } from './time';

export const KIND_LABEL: Record<ClipKind, string> = {
  text: 'Text', url: 'Link', code: 'Code', html: 'Rich text', image: 'Image', file: 'File',
};

export const KIND_ICON: Record<ClipKind, ComponentType<LucideProps>> = {
  text: Type, url: Link, code: Code, html: Type, image: Image, file: File,
};

export function SearchBar({ value, onChange, inputRef }: { value: string; onChange: (v: string) => void; inputRef?: React.Ref<HTMLInputElement> }) {
  return (
    <label className="flex items-center gap-2 rounded-lg border border-line bg-raised px-3 py-2 focus-within:border-accent">
      <Search aria-hidden className="size-4 shrink-0 text-muted" />
      <input
        ref={inputRef}
        type="search"
        aria-label="Search clipboard history"
        placeholder="Search…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full bg-transparent text-sm text-ink placeholder:text-muted focus:outline-none"
      />
    </label>
  );
}

export function KindFilter({ value, onChange }: { value: readonly ClipKind[]; onChange: (v: ClipKind[]) => void }) {
  const toggle = (kind: ClipKind): void =>
    onChange(value.includes(kind) ? value.filter((k) => k !== kind) : [...value, kind]);
  return (
    <div role="group" aria-label="Filter by type" className="flex flex-wrap gap-1.5">
      {(Object.keys(KIND_LABEL) as ClipKind[]).map((kind) => {
        const on = value.includes(kind);
        return (
          <button
            key={kind}
            type="button"
            aria-pressed={on}
            onClick={() => toggle(kind)}
            className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
              on ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted hover:text-ink'
            }`}
          >
            {KIND_LABEL[kind]}
          </button>
        );
      })}
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
  const [busy, setBusy] = useState(false);
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
      className={`group rounded-xl border bg-raised p-3 transition-colors hover:border-accent/50 ${selected ? 'border-accent' : 'border-line'}`}
    >
      <header className="mb-2 flex items-center gap-2 text-xs text-muted">
        {onSelect && (selected ? <CheckSquare aria-hidden className="size-4 text-accent" /> : <Square aria-hidden className="size-4" />)}
        <span className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 font-medium text-ink">
          <KindIcon aria-hidden className="size-3.5" />
          {KIND_LABEL[meta.kind]}
        </span>
        {meta.pinned && <Pin aria-label="Pinned" className="size-3.5 text-accent" />}
        {meta.favorite && <Star aria-label="Favorite" className="size-3.5 fill-accent text-accent" />}
        {meta.title && <span className="truncate font-medium text-ink">{meta.title}</span>}
        <span className="ml-auto whitespace-nowrap">
          <time dateTime={new Date(meta.createdAt).toISOString()}>{formatRelative(meta.createdAt, now)}</time>
          {deviceName && <> · {deviceName}</>}
        </span>
      </header>

      <button
        type="button"
        onClick={() => (onSelect ? onSelect() : onOpen?.(item))}
        disabled={!onOpen && !onSelect}
        {...(onSelect ? { 'aria-pressed': !!selected } : {})}
        aria-label={`${onSelect ? 'Select' : 'Open'} ${KIND_LABEL[meta.kind].toLowerCase()} item`}
        className="block w-full cursor-pointer text-left disabled:cursor-default"
      >
        {meta.kind === 'image' ? (
          thumb ? (
            <img src={thumb} alt={meta.title ?? 'Clipboard image'} className="max-h-40 rounded-md object-contain" />
          ) : (
            <div className="flex h-24 items-center justify-center rounded-md bg-surface text-xs text-muted">Image</div>
          )
        ) : (
          <p className={`line-clamp-4 text-sm break-words whitespace-pre-wrap ${meta.kind === 'code' ? 'font-mono text-xs' : ''}`}>
            {item.preview}
          </p>
        )}
      </button>

      {!onSelect && <footer className="mt-2 flex gap-1 text-xs opacity-70 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
        {meta.kind === 'file'
          ? <IconButton icon={Download} label="Save" disabled={busy} onClick={act(async () => void (await client.saveFile(item.id)))} />
          : <IconButton icon={Copy} label="Copy" disabled={busy} onClick={act(() => client.copy(item.id))} />}
        <IconButton icon={Pin} label={meta.pinned ? 'Unpin' : 'Pin'} pressed={meta.pinned} disabled={busy} onClick={act(() => client.setFlags(item.id, { pinned: !meta.pinned }))} />
        <IconButton icon={Star} label={meta.favorite ? 'Unfavorite' : 'Favorite'} pressed={meta.favorite} disabled={busy} onClick={act(() => client.setFlags(item.id, { favorite: !meta.favorite }))} />
        <IconButton icon={Trash} label="Delete" danger disabled={busy} onClick={act(() => client.remove([item.id]))} />
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
      className={`flex items-center gap-1 rounded px-2 py-1 transition-colors disabled:opacity-50 ${
        props.danger ? 'text-muted hover:text-danger' : props.pressed ? 'text-accent' : 'text-muted hover:text-ink'
      }`}
    >
      <Icon aria-hidden className={`size-3.5 ${props.pressed ? 'fill-current' : ''}`} />
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
    return <p className="p-8 text-center text-sm text-muted">{filter.query ? 'No matches.' : props.emptyText ?? 'Nothing copied yet.'}</p>;
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
      <div role="toolbar" aria-label="Selection" className="flex items-center gap-1 text-xs text-muted">
        {selected ? (
          <>
            <span className="mr-auto">{visible.length} selected</span>
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
          <button type="button" onClick={() => setSelected(new Set())} className="ml-auto rounded px-2 py-1 hover:text-ink">Select</button>
        )}
      </div>
      <ul className="space-y-2">
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

import { useState } from 'react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { useClipply } from './client';
import { useClipList, useThumbUrl } from './hooks';
import { formatRelative } from './time';

export const KIND_LABEL: Record<ClipKind, string> = {
  text: 'Text', url: 'Link', code: 'Code', html: 'Rich text', image: 'Image', file: 'File',
};

export function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="search"
      aria-label="Search clipboard history"
      placeholder="Search…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none"
    />
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
}

export function ClipCard({ item, now, deviceName }: CardProps) {
  const client = useClipply();
  const { meta } = item;
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
      className="group rounded-xl border border-line bg-raised p-3 transition-colors hover:border-accent/50"
    >
      <header className="mb-2 flex items-center gap-2 text-xs text-muted">
        <span className="rounded bg-surface px-1.5 py-0.5 font-medium text-ink">{KIND_LABEL[meta.kind]}</span>
        {meta.title && <span className="truncate font-medium text-ink">{meta.title}</span>}
        <span className="ml-auto whitespace-nowrap">
          <time dateTime={new Date(meta.createdAt).toISOString()}>{formatRelative(meta.createdAt, now)}</time>
          {deviceName && <> · {deviceName}</>}
        </span>
      </header>

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

      <footer className="mt-2 flex gap-1 text-xs">
        <CardButton label="Copy" disabled={busy} onClick={act(() => client.copy(item.id))} />
        <CardButton label={meta.pinned ? 'Unpin' : 'Pin'} pressed={meta.pinned} disabled={busy} onClick={act(() => client.setFlags(item.id, { pinned: !meta.pinned }))} />
        <CardButton label={meta.favorite ? 'Unfavorite' : 'Favorite'} pressed={meta.favorite} disabled={busy} onClick={act(() => client.setFlags(item.id, { favorite: !meta.favorite }))} />
        <CardButton label="Delete" danger disabled={busy} onClick={act(() => client.remove([item.id]))} />
      </footer>
    </article>
  );
}

function CardButton(props: { label: string; onClick: () => void; pressed?: boolean; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      disabled={props.disabled}
      {...(props.pressed !== undefined ? { 'aria-pressed': props.pressed } : {})}
      className={`rounded px-2 py-1 transition-colors disabled:opacity-50 ${
        props.danger ? 'text-muted hover:text-danger' : props.pressed ? 'text-accent' : 'text-muted hover:text-ink'
      }`}
    >
      {props.label}
    </button>
  );
}

export function ClipList({ filter, deviceNames = {}, now = Date.now() }: { filter: ListFilter; deviceNames?: Record<string, string>; now?: number }) {
  const { items, error } = useClipList(filter);
  if (error) return <p role="alert" className="p-4 text-sm text-danger">Could not load history: {error.message}</p>;
  if (!items) {
    return (
      <div aria-busy="true" className="space-y-2">
        {[0, 1, 2].map((i) => <div key={i} className="h-20 animate-pulse rounded-xl bg-raised" />)}
      </div>
    );
  }
  if (items.length === 0) {
    return <p className="p-8 text-center text-sm text-muted">{filter.query ? 'No matches.' : 'Nothing copied yet.'}</p>;
  }
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li key={item.id}>
          <ClipCard item={item} now={now} deviceName={deviceNames[item.meta.originDeviceId]} />
        </li>
      ))}
    </ul>
  );
}

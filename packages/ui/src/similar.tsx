import { useEffect, useRef, useState } from 'react';
import { Star, X } from 'lucide-react';
import type { ClipView } from '@clipply/sync-engine';

import { useClipply, type ClipplyClient } from './client';
import { isFavorite, KIND_LABEL } from './components';
import { useThumbUrl } from './hooks';
import { buttonClass } from './settings';
import { groupSimilarImages, markImage, type ImageMark } from './similarImages';
import { formatBytes, formatRelative } from './time';

const PAGE = 200;

/** Favorites first, then newest: the first of a group is the one to keep. */
const bestFirst = (a: ClipView, b: ClipView): number => Number(isFavorite(b.meta)) - Number(isFavorite(a.meta)) || b.meta.createdAt - a.meta.createdAt;

async function similarImages(client: ClipplyClient, mark: typeof markImage, onProgress: (done: number, total: number) => void): Promise<ClipView[][]> {
  const marks: ImageMark[] = [];
  const views = new Map<string, ClipView>();
  for (let offset = 0; ; offset += PAGE) {
    const { items, total } = await client.list({ kinds: ['image'], offset, limit: PAGE });
    for (const v of items) {
      views.set(v.id, v);
      // Only the thumbnail is read: full images may not even be on this device.
      const thumb = v.hasThumb ? await client.readThumb(v.id).catch(() => null) : null;
      const m = thumb && (await mark(v.id, thumb));
      if (m) marks.push(m);
      onProgress(views.size, total);
    }
    if (items.length < PAGE) break;
  }
  return groupSimilarImages(marks).map((ids) => ids.map((id) => views.get(id)!).sort(bestFirst));
}

const extras = (g: readonly ClipView[]): ClipView[] => g.slice(1).filter((v) => !isFavorite(v.meta));

/** Finds clips that are nearly the same. Nothing is deleted until the user picks a group; favorites never are. */
export function SimilarPanel({ mark = markImage }: { mark?: typeof markImage }) {
  const client = useClipply();
  const [progress, setProgress] = useState<string | null>(null);
  const [groups, setGroups] = useState<ClipView[][] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const find = (): void => {
    setNote(null);
    setProgress('Comparing texts…');
    void (async () => {
      try {
        const texts = await client.similarTexts();
        const images = await similarImages(client, mark, (done, total) => setProgress(`Comparing images… ${done} of ${total}`));
        const found = [...texts, ...images].filter((g) => extras(g).length > 0);
        if (found.length === 0) setNote('No similar clips found.');
        else setGroups(found);
      } catch (e) {
        setNote(e instanceof Error ? e.message : String(e));
      } finally {
        setProgress(null);
      }
    })();
  };
  const done = (removed: number): void => {
    setGroups(null);
    if (removed > 0) setNote(`Deleted ${removed} clip${removed === 1 ? '' : 's'}.`);
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
        <span className="min-w-0 flex-1 basis-40">
          <span className="block text-ink">Similar clips</span>
          <span className="mt-0.5 block text-xs text-muted">Compares texts and images on this device. You choose what to delete.</span>
        </span>
        <button type="button" onClick={find} disabled={progress !== null} className={buttonClass.plain}>Find similar clips</button>
      </div>
      {progress && <p role="status" className="text-xs text-muted tabular-nums">{progress}</p>}
      {note && <p role="status" className="text-xs text-muted">{note}</p>}
      {groups && <SimilarDialog groups={groups} onClose={done} />}
    </div>
  );
}

function SimilarDialog({ groups: found, onClose }: { groups: ClipView[][]; onClose: (removed: number) => void }) {
  const client = useClipply();
  const [groups, setGroups] = useState(found);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const removed = useRef(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const close = (): void => onClose(removed.current);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const drop = (which: ClipView[][]): void => {
    const ids = which.flatMap(extras).map((v) => v.id);
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        // The platform takes at most 1000 ids per call.
        for (let i = 0; i < ids.length; i += 500) {
          const part = ids.slice(i, i + 500);
          await client.remove(part);
          removed.current += part.length;
        }
        const left = groups.filter((g) => !which.includes(g));
        if (left.length === 0) close();
        else setGroups(left);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };
  const total = groups.flatMap(extras).length;

  return (
    <div className="fixed inset-0 z-50 flex bg-black/70 sm:items-center sm:justify-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div role="dialog" aria-modal="true" aria-label="Similar clips" className="flex h-full w-full flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:h-[min(85vh,52rem)] sm:max-w-3xl sm:overflow-hidden sm:rounded-2xl sm:pt-0 sm:pb-0 sm:shadow-2xl sm:ring-1 sm:ring-line">
        <header className="flex items-center gap-2 border-b border-line py-2 pr-3 pl-1">
          <button ref={closeRef} type="button" aria-label="Close" onClick={close} className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-ink"><X aria-hidden className="size-5" /></button>
          <p className="min-w-0 flex-1 truncate text-base font-semibold text-ink">Similar clips ({groups.length} group{groups.length === 1 ? '' : 's'})</p>
        </header>
        {error && <p role="alert" className="px-4 py-2 text-sm text-danger">{error}</p>}
        <ul className="min-h-0 flex-1 space-y-4 overflow-auto p-4">
          {groups.map((g) => {
            const n = extras(g).length;
            return (
              <li key={g[0]!.id} className="space-y-2 rounded-2xl border border-line bg-raised p-3">
                <ul className="grid gap-2 sm:grid-cols-2">
                  {g.map((v, i) => <SimilarItem key={v.id} item={v} keep={i === 0 || isFavorite(v.meta)} />)}
                </ul>
                <div className="flex justify-end">
                  <button type="button" disabled={busy} onClick={() => drop([g])} className={buttonClass.danger}>Delete {n} other{n === 1 ? '' : 's'}</button>
                </div>
              </li>
            );
          })}
        </ul>
        <footer className="flex justify-end border-t border-line p-3 *:max-sm:flex-1">
          <button
            type="button"
            disabled={busy}
            onClick={() => window.confirm(`Delete ${total} clip${total === 1 ? '' : 's'} and keep one of each group? This also removes them from your other devices and cannot be undone.`) && drop(groups)}
            className={buttonClass.danger}
          >
            Keep one of each, delete {total}
          </button>
        </footer>
      </div>
    </div>
  );
}

function SimilarItem({ item, keep }: { item: ClipView; keep: boolean }) {
  const thumb = useThumbUrl(item.id, item.hasThumb);
  const { meta } = item;
  return (
    <li className={`flex gap-3 rounded-xl border p-2.5 ${keep ? 'border-accent' : 'border-line opacity-80'}`}>
      {thumb && <img src={thumb} alt="" className="size-20 shrink-0 rounded-lg border border-line object-cover" />}
      <div className="min-w-0 flex-1 text-xs text-muted">
        <p className="flex items-center gap-1.5">
          <span className={keep ? 'font-semibold text-accent' : ''}>{keep ? 'Keep' : 'Delete'}</span>
          {isFavorite(meta) && <Star aria-label="Favorite" className="size-3.5 fill-accent text-accent" />}
          <span>{KIND_LABEL[meta.kind]} · {formatBytes(meta.size)} · {formatRelative(meta.createdAt, Date.now())}</span>
        </p>
        {item.preview && <p dir="auto" className="mt-1 line-clamp-4 text-sm break-words whitespace-pre-wrap text-ink">{item.preview}</p>}
      </div>
    </li>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Copy, Download, ExternalLink, Maximize, Pencil, Save, Scan, Trash, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ClipView } from '@clipply/sync-engine';

import { useClipply } from './client';
import { IconButton, KIND_LABEL } from './components';
import { formatRelative } from './time';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/** Modal for one item: image preview with zoom, or text view/edit. Plaintext stays in memory. */
export function ItemViewer({ item, onClose, deviceName }: { item: ClipView; onClose: () => void; deviceName?: string | undefined }) {
  const client = useClipply();
  const { meta } = item;
  const [body, setBody] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let alive = true;
    client.readBody(item.id).then(
      (b) => alive && setBody(b),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [client, item.id]);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const remove = async (): Promise<void> => {
    await client.remove([item.id]);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={`${KIND_LABEL[meta.kind]} item`} className="flex max-h-full w-full max-w-4xl flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3 text-xs text-muted">
          <span className="font-medium text-ink">{meta.title ?? KIND_LABEL[meta.kind]}</span>
          <span>{formatBytes(meta.size)}</span>
          <span>{meta.mime.split(';')[0]}</span>
          <span>{formatRelative(meta.createdAt, Date.now())}{deviceName && ` · ${deviceName}`}</span>
          {meta.editedAt && <span>edited {formatRelative(meta.editedAt, Date.now())}</span>}
          <span className="ml-auto flex gap-1">
            {meta.kind === 'file' || meta.kind === 'image' ? <IconButton icon={Download} label="Save" onClick={() => void client.saveFile(item.id)} /> : null}
            {meta.kind !== 'file' && <IconButton icon={Copy} label="Copy" onClick={() => void client.copy(item.id)} />}
            {meta.kind === 'url' && <IconButton icon={ExternalLink} label="Open link" onClick={() => void client.openUrl(item.id)} />}
            <IconButton icon={Trash} label="Delete" danger onClick={() => void remove()} />
            <button ref={closeRef} type="button" aria-label="Close" title="Close" onClick={onClose} className="rounded px-2 py-1 text-muted hover:text-ink">
              <X aria-hidden className="size-4" />
            </button>
          </span>
        </header>
        <div className="min-h-0 flex-1 overflow-hidden">
          {error ? (
            <p role="alert" className="p-6 text-sm text-danger">Could not open item: {error}</p>
          ) : !body ? (
            <div aria-busy="true" className="m-6 h-40 animate-pulse rounded-xl bg-raised" />
          ) : meta.kind === 'image' ? (
            <ImagePane bytes={body} mime={meta.mime} alt={meta.title ?? 'Clipboard image'} />
          ) : meta.kind === 'file' ? (
            <p className="p-6 text-sm text-muted">{meta.file?.name ?? 'File'} — {formatBytes(meta.size)}</p>
          ) : (
            <TextPane id={item.id} text={new TextDecoder().decode(body)} mono={meta.kind === 'code' || meta.kind === 'html'} />
          )}
        </div>
      </div>
    </div>
  );
}

function ImagePane({ bytes, mime, alt }: { bytes: Uint8Array; mime: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');

  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);

  const current = zoom === 'fit' ? 1 : zoom;
  const step = (dir: 1 | -1): void => {
    const idx = ZOOM_STEPS.findIndex((z) => z >= current - 1e-9);
    const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, (idx < 0 ? ZOOM_STEPS.length - 1 : idx) + dir))]!;
    setZoom(next);
  };

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-xs text-muted">
        <IconButton icon={ZoomOut} label="Zoom out" onClick={() => step(-1)} />
        <span aria-live="polite" className="w-12 text-center">{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
        <IconButton icon={ZoomIn} label="Zoom in" onClick={() => step(1)} />
        <IconButton icon={Maximize} label="Fit to window" pressed={zoom === 'fit'} onClick={() => setZoom('fit')} />
        <IconButton icon={Scan} label="Actual size" pressed={zoom === 1} onClick={() => setZoom(1)} />
      </div>
      <div
        className="min-h-0 flex-1 overflow-auto bg-[repeating-conic-gradient(#0000_0_25%,#ffffff0a_0_50%)] bg-[length:16px_16px]"
        onWheel={(e) => {
          if (e.ctrlKey) step(e.deltaY < 0 ? 1 : -1);
        }}
      >
        {url && (
          <img
            src={url}
            alt={alt}
            style={zoom === 'fit' ? undefined : { width: `calc(var(--natural-w) * ${zoom})`, maxWidth: 'none' }}
            onLoad={(e) => e.currentTarget.style.setProperty('--natural-w', `${e.currentTarget.naturalWidth}px`)}
            className={zoom === 'fit' ? 'mx-auto h-full w-full object-contain' : 'm-auto block'}
          />
        )}
      </div>
    </div>
  );
}

function TextPane({ id, text, mono }: { id: string; text: string; mono: boolean }) {
  const client = useClipply();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await client.editText(id, draft);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex h-[70vh] flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-xs text-muted">
        {editing ? (
          <>
            <button type="button" onClick={() => void save()} disabled={saving} className="flex items-center gap-1 rounded bg-accent/15 px-2 py-1 text-accent disabled:opacity-50">
              <Save aria-hidden className="size-3.5" /> Save
            </button>
            <button type="button" onClick={() => { setDraft(text); setEditing(false); }} className="rounded px-2 py-1 hover:text-ink">Cancel</button>
          </>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1 rounded px-2 py-1 hover:text-ink">
            <Pencil aria-hidden className="size-3.5" /> Edit
          </button>
        )}
        {error && <span role="alert" className="text-danger">{error}</span>}
      </div>
      {editing ? (
        <textarea
          aria-label="Edit text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className={`min-h-0 flex-1 resize-none bg-surface p-4 text-sm text-ink focus:outline-none ${mono ? 'font-mono text-xs' : ''}`}
        />
      ) : (
        <pre className={`min-h-0 flex-1 overflow-auto p-4 text-sm break-words whitespace-pre-wrap ${mono ? 'font-mono text-xs' : 'font-sans'}`}>{text}</pre>
      )}
    </div>
  );
}

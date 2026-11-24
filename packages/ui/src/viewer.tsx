import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Check, Copy, Download, ExternalLink, Maximize, Pencil, Save, Scan, ScanText, Trash, WandSparkles, X, ZoomIn, ZoomOut } from 'lucide-react';
import type { ClipView } from '@clipply/sync-engine';

import { useClipply } from './client';
import { IconButton, KIND_ICON, KIND_LABEL } from './components';
import { formatRelative } from './time';
import { TRANSFORMS, type TextTransform } from './transforms';

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

/**
 * One item, full screen on phones and a centred card from `sm` up: a top bar (close, kind, title,
 * one line of details, delete), the content, and a bottom bar with the main actions. Plaintext
 * stays in memory.
 */
/** `action: 'scan'` (images): start copying the image's text as soon as it opens. */
export function ItemViewer({ item, onClose, deviceName, action }: { item: ClipView; onClose: () => void; deviceName?: string | undefined; action?: 'scan' | undefined }) {
  const client = useClipply();
  const { meta } = item;
  const [body, setBody] = useState<Uint8Array | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const KindIcon = KIND_ICON[meta.kind];
  const now = Date.now();

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

  const remove = (): void => {
    // Optimistic: the list hides the item now and brings it back if the delete fails.
    onClose();
    void client.remove([item.id]);
  };
  const copy = async (): Promise<void> => {
    await client.copy(item.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const details = [
    formatBytes(meta.size),
    meta.mime.split(';')[0],
    formatRelative(meta.createdAt, now) + (deviceName ? `, from ${deviceName}` : ''),
    ...(meta.editedAt ? [`edited ${formatRelative(meta.editedAt, now)}`] : []),
  ];
  const actions = [
    ...(meta.kind !== 'file' ? [{ icon: copied ? Check : Copy, label: copied ? 'Copied' : 'Copy', name: 'Copy', onClick: () => void copy() }] : []),
    ...(meta.kind === 'url' ? [{ icon: ExternalLink, label: 'Open', name: 'Open link', onClick: () => void client.openUrl(item.id) }] : []),
    ...(meta.kind === 'file' || meta.kind === 'image' ? [{ icon: Download, label: 'Save', name: 'Save', onClick: () => void client.saveFile(item.id) }] : []),
  ];

  return (
    <div className="fixed inset-0 z-50 flex bg-black/70 sm:items-center sm:justify-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`${KIND_LABEL[meta.kind]} item`}
        style={{ '--kind': `var(--color-kind-${meta.kind})` } as CSSProperties}
        className="flex h-full w-full flex-col bg-surface pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:h-[min(85vh,52rem)] sm:max-w-4xl sm:overflow-hidden sm:rounded-2xl sm:pt-0 sm:pb-0 sm:shadow-2xl sm:ring-1 sm:ring-line"
      >
        <header className="flex items-center gap-2 border-b border-line py-2 pr-2 pl-1">
          <button ref={closeRef} type="button" aria-label="Close" title="Close" onClick={onClose} className="flex size-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-raised hover:text-ink">
            <X aria-hidden className="size-5" />
          </button>
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-(--kind)/12 text-(--kind)">
            <KindIcon className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-base font-semibold text-ink">{meta.title ?? (meta.kind === 'file' ? meta.file?.name : null) ?? KIND_LABEL[meta.kind]}</p>
            <p className="truncate text-xs text-muted">{details.join(' · ')}</p>
          </div>
          <IconButton icon={Trash} label="Delete" danger onClick={() => void remove()} />
        </header>
        <div className="flex min-h-0 flex-1 flex-col">
          {error ? (
            <p role="alert" className="p-6 text-sm text-danger">Could not open item: {error}</p>
          ) : !body ? (
            <div aria-busy="true" className="m-4 h-40 animate-pulse rounded-xl bg-raised" />
          ) : meta.kind === 'image' ? (
            <ImageView id={item.id} bytes={body} mime={meta.mime} alt={meta.title ?? 'Clipboard image'} initialText={meta.ocr} scanNow={action === 'scan'} />
          ) : meta.kind === 'file' ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <span aria-hidden className="flex size-20 items-center justify-center rounded-3xl bg-(--kind)/12 text-(--kind)"><KindIcon className="size-10" /></span>
              <p className="max-w-full font-semibold break-words text-ink">{meta.file?.name ?? 'File'}</p>
              <p className="text-sm text-muted">{formatBytes(meta.size)}</p>
            </div>
          ) : (
            <TextPane id={item.id} text={new TextDecoder().decode(body)} mono={meta.kind === 'code' || meta.kind === 'html'} onSaved={onClose} />
          )}
        </div>
        <footer className="flex gap-2 border-t border-line p-3">
            <button
              type="button"
              onClick={onClose}
              className="flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-ink ring-1 ring-line transition-colors hover:bg-raised sm:flex-none sm:px-6"
            >
              <X aria-hidden className="size-4.5" />
              Close
            </button>
            {actions.map(({ icon: Icon, label, name, onClick }, i) => (
              <button
                key={name}
                type="button"
                aria-label={name}
                onClick={onClick}
                className={`flex flex-1 items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-colors sm:flex-none sm:px-6 ${
                  i === 0 ? 'bg-(--kind) text-white hover:brightness-110' : 'bg-(--kind)/12 text-(--kind) hover:bg-(--kind)/20'
                } ${i === 0 ? 'sm:ml-auto' : ''}`}
              >
                <Icon aria-hidden className="size-4.5" />
                {label}
              </button>
            ))}
        </footer>
      </div>
    </div>
  );
}

function ImagePane({ bytes, mime, alt, scanning }: { bytes: Uint8Array; mime: string; alt: string; scanning: boolean }) {
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 py-1.5 text-xs text-muted">
        <IconButton icon={ZoomOut} label="Zoom out" onClick={() => step(-1)} />
        <span aria-live="polite" className="w-12 text-center">{zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`}</span>
        <IconButton icon={ZoomIn} label="Zoom in" onClick={() => step(1)} />
        <IconButton icon={Maximize} label="Fit to window" pressed={zoom === 'fit'} onClick={() => setZoom('fit')} />
        <IconButton icon={Scan} label="Actual size" pressed={zoom === 1} onClick={() => setZoom(1)} />
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col">
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
        {scanning && (
          <div role="status" className="pointer-events-none absolute inset-0 overflow-hidden bg-strip/10">
            {/* A glowing band sweeps down the image; reduced motion keeps only the tint and the label. */}
            <div aria-hidden className="absolute inset-0 border-b-2 border-clip bg-linear-to-b from-transparent via-clip/10 to-clip/35 shadow-[0_8px_28px_rgb(6_173_191/0.55)] motion-safe:animate-scan motion-reduce:hidden" />
            <span className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-frame/85 px-4 py-2 text-sm font-semibold whitespace-nowrap text-frame-ink shadow-lg">
              <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-frame-ink border-t-transparent" /> Scanning for text…
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/** `onSaved` runs after a successful save (the viewer closes); a failed save keeps the editor open with the error. */
function TextPane({ id, text, mono, onSaved }: { id: string; text: string; mono: boolean; onSaved: () => void }) {
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
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  // Applies to what is on screen; the result opens in the editor so it can be checked, saved or cancelled.
  const transform = (t: TextTransform): void => {
    setError(null);
    try {
      const next = t.apply(editing ? draft : text);
      if (next === (editing ? draft : text)) return setError('Nothing to change.');
      setDraft(next);
      setEditing(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-sm text-muted">
        {editing ? (
          <>
            <button type="button" onClick={() => void save()} disabled={saving} className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 font-semibold text-white disabled:opacity-50">
              <Save aria-hidden className="size-4" /> Save
            </button>
            <button type="button" onClick={() => { setDraft(text); setEditing(false); }} className="rounded-full px-4 py-1.5 hover:bg-raised hover:text-ink">Cancel</button>
          </>
        ) : (
          <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1.5 rounded-full px-3 py-1.5 ring-1 ring-line hover:bg-raised hover:text-ink">
            <Pencil aria-hidden className="size-4" /> Edit
          </button>
        )}
        <label className="flex min-w-0 items-center gap-1.5 rounded-full py-1 pr-1 pl-3 ring-1 ring-line focus-within:ring-2 focus-within:ring-accent hover:text-ink">
          <WandSparkles aria-hidden className="size-4 shrink-0" />
          <select
            aria-label="Transform text"
            value=""
            onChange={(e) => {
              const t = TRANSFORMS.find((x) => x.id === e.target.value);
              if (t) transform(t);
            }}
            className="min-w-0 cursor-pointer bg-transparent py-0.5 pr-1 text-ink focus:outline-none"
          >
            <option value="" disabled>Transform…</option>
            {TRANSFORMS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
        </label>
        {error ? <span role="alert" className="min-w-0 break-words text-danger">{error}</span> : editing && <span className="ml-auto hidden text-xs sm:inline">Ctrl+Enter to save</span>}
      </div>
      {editing ? (
        <textarea
          aria-label="Edit text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !saving) {
              e.preventDefault();
              void save();
            }
          }}
          className={`min-h-0 flex-1 resize-none bg-surface p-4 text-base text-ink focus:outline-none ${mono ? 'font-mono text-sm' : ''}`}
        />
      ) : (
        <pre className={`min-h-0 flex-1 overflow-auto p-4 break-words whitespace-pre-wrap text-ink ${mono ? 'font-mono text-sm leading-relaxed' : 'font-sans text-base leading-relaxed'}`}>{text}</pre>
      )}
    </div>
  );
}

/**
 * An image plus its text. OCR never runs by itself: "Copy text" recognizes the text on this device (a scan
 * sweeps the image meanwhile), copies it, and stores it with the item so it syncs and is searchable. The
 * text opens in an editor: changes there only affect what is copied next, the stored text stays as read.
 */
function ImageView({ id, bytes, mime, alt, initialText, scanNow }: { id: string; bytes: Uint8Array; mime: string; alt: string; initialText: string | undefined; scanNow: boolean }) {
  const client = useClipply();
  const [text, setText] = useState(initialText);
  const [draft, setDraft] = useState(initialText ?? '');
  const [shown, setShown] = useState(!!initialText);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyText = async (): Promise<void> => {
    setError(null);
    try {
      let t = draft;
      if (text === undefined) {
        setScanning(true);
        t = await client.recognizeText(id).finally(() => setScanning(false));
        setText(t);
        setDraft(t);
      }
      setShown(true);
      if (!t.trim()) return;
      await client.copyText(t);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  // Opened from a card's scan button. The ref keeps React's dev double-run from scanning twice.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!scanNow || autoStarted.current) return;
    autoStarted.current = true;
    void copyText();
  }, [scanNow]);

  const open = shown && !!text;
  return (
    <>
      <ImagePane bytes={bytes} mime={mime} alt={alt} scanning={scanning} />
      <section aria-label="Text in image" className="flex max-h-[45vh] shrink-0 flex-col border-t border-line text-sm">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-muted">
          <ScanText aria-hidden className="size-4 shrink-0" />
          <span className="font-semibold text-ink">Text in image</span>
          {text === '' ? (
            <span className="ml-auto">No text found</span>
          ) : (
            <span className="ml-auto flex items-center gap-1.5">
              {open && (
                <button type="button" aria-label="Close text" onClick={() => setShown(false)} className="flex items-center gap-1.5 rounded-full px-3 py-1 hover:bg-raised hover:text-ink">
                  <X aria-hidden className="size-4" /> Close
                </button>
              )}
              <button type="button" onClick={() => void copyText()} disabled={scanning || (text !== undefined && !draft.trim())} className="flex items-center gap-1.5 rounded-full px-3 py-1 ring-1 ring-line hover:bg-raised hover:text-ink disabled:opacity-50">
                {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />} {scanning ? 'Scanning…' : copied ? 'Copied' : 'Copy text'}
              </button>
            </span>
          )}
          {error && <span role="alert" className="w-full break-words text-danger">{error}</span>}
        </div>
        {open && (
          <textarea
            aria-label="Recognized text"
            value={draft}
            rows={6}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void copyText();
              }
            }}
            className="mx-3 mb-3 min-h-0 flex-1 resize-none rounded-lg bg-raised p-3 text-ink ring-1 ring-line focus:ring-2 focus:ring-accent focus:outline-none"
          />
        )}
      </section>
    </>
  );
}

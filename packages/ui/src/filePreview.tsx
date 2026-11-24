import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Eye } from 'lucide-react';
import type { ClipView } from '@clipply/sync-engine';

import { buttonClass } from './settings';
import { formatBytes } from './time';

export type PreviewKind = 'pdf' | 'image' | 'audio' | 'video' | 'csv' | 'text';

const EXT: Record<string, PreviewKind> = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
  mp3: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio', wav: 'audio', flac: 'audio', aac: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
  csv: 'csv', tsv: 'csv',
};

/** What a file's type says it is; null when only its contents can tell (see `looksLikeText`). */
export function previewKind(mime: string, name: string): PreviewKind | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  const type = mime.split(';')[0]!.trim().toLowerCase();
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/csv' || type === 'text/tab-separated-values') return 'csv';
  if (/^(image|audio|video)\//.test(type) && EXT[ext] !== 'text') return type.split('/')[0] as PreviewKind;
  return EXT[ext] ?? (type.startsWith('text/') ? 'text' : null);
}

/** UTF-8 without control characters: worth showing, whatever the file is called. */
export function looksLikeText(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 4096);
  if (head.some((b) => b < 9 || (b > 13 && b < 32 && b !== 27))) return false;
  try {
    // `stream`: the cut may be in the middle of a character.
    new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: true });
    return true;
  } catch {
    return false;
  }
}

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_ROWS = 500;
const MAX_COLUMNS = 50;
/** Opening a file downloads all of it, so larger ones wait for a tap. */
export const AUTO_PREVIEW_BYTES = 20 * 1024 * 1024;

/** CSV/TSV rows; quoted fields may hold separators, quotes ("") and line breaks. The separator is the likeliest one of the first line. */
export function parseCsv(text: string, maxRows = MAX_ROWS): string[][] {
  const first = text.slice(0, text.search(/\r?\n|$/));
  const sep = [',', ';', '\t', '|'].reduce((best, s) => (first.split(s).length > first.split(best).length ? s : best), ',');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = (): void => {
    row.push(field);
    field = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n') endRow();
    else if (c !== '\r' || text[i + 1] !== '\n') field += c;
  }
  if (rows.length < maxRows && (field !== '' || row.length > 0)) endRow();
  return rows;
}

function useObjectUrl(bytes: Uint8Array, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes, mime]);
  return url;
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="border-b border-line bg-raised px-4 py-2 text-xs text-muted">{children}</p>;
}

/** A file's contents, from memory: PDF pages, image, audio/video player, table or text; its icon and size when none fits. */
export function FilePreview({ item, bytes, fallback }: { item: ClipView; bytes: Uint8Array; fallback: ReactNode }) {
  const name = item.meta.file?.name ?? '';
  const kind = useMemo(() => previewKind(item.meta.mime, name) ?? (looksLikeText(bytes) ? 'text' : null), [item.meta.mime, name, bytes]);
  // A broken or unsupported file falls back to the icon with a short reason.
  const [failed, setFailed] = useState<string | null>(null);
  if (kind === null) return <>{fallback}</>;
  if (failed !== null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <Notice>{failed}</Notice>
        {fallback}
      </div>
    );
  }
  switch (kind) {
    case 'pdf':
      return <PdfPreview bytes={bytes} onError={setFailed} />;
    case 'image':
      return <ImageFile bytes={bytes} mime={item.meta.mime.startsWith('image/') ? item.meta.mime : imageMime(name)} name={name} onError={setFailed} />;
    case 'audio':
    case 'video':
      return <MediaFile kind={kind} bytes={bytes} mime={item.meta.mime} name={name} onError={setFailed} />;
    case 'csv':
      return <CsvPreview bytes={bytes} />;
    case 'text':
      return <TextFile bytes={bytes} />;
  }
}

const imageMime = (name: string): string => (/\.svg$/i.test(name) ? 'image/svg+xml' : `image/${/\.jpe?g$/i.test(name) ? 'jpeg' : (/\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? 'png')}`);

/** SVG included: scripts in it never run inside an <img>. */
function ImageFile({ bytes, mime, name, onError }: { bytes: Uint8Array; mime: string; name: string; onError: (m: string) => void }) {
  const url = useObjectUrl(bytes, mime);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-[repeating-conic-gradient(#0000_0_25%,#ffffff0a_0_50%)] bg-[length:16px_16px] p-2">
      {url && <img src={url} alt={name} onError={() => onError('This image could not be shown.')} className="max-h-full max-w-full object-contain" />}
    </div>
  );
}

function MediaFile({ kind, bytes, mime, name, onError }: { kind: 'audio' | 'video'; bytes: Uint8Array; mime: string; name: string; onError: (m: string) => void }) {
  // QuickTime files usually hold the same streams as MP4; the player decides by the label.
  const url = useObjectUrl(bytes, mime === 'video/quicktime' ? 'video/mp4' : mime === 'application/octet-stream' ? '' : mime);
  const fail = (): void => onError(`This ${kind} format cannot be played here. Save it to open it in another app.`);
  if (!url) return null;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black/90 p-4">
      {kind === 'video' ? (
        <video src={url} aria-label={name} controls playsInline onError={fail} className="max-h-full max-w-full" />
      ) : (
        <audio src={url} aria-label={name} controls onError={fail} className="w-full max-w-xl" />
      )}
    </div>
  );
}

function decodeText(bytes: Uint8Array): { text: string; cut: boolean } {
  const cut = bytes.length > MAX_TEXT_BYTES;
  return { text: new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_BYTES), { stream: cut }), cut };
}

function TextFile({ bytes }: { bytes: Uint8Array }) {
  const { text, cut } = useMemo(() => decodeText(bytes), [bytes]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {cut && <Notice>Showing the first {formatBytes(MAX_TEXT_BYTES)} of {formatBytes(bytes.length)}. Save the file to see all of it.</Notice>}
      <pre dir="auto" aria-label="File contents" className="min-h-0 flex-1 overflow-auto p-4 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap text-ink">{text}</pre>
    </div>
  );
}

function CsvPreview({ bytes }: { bytes: Uint8Array }) {
  const { rows, columns, cut } = useMemo(() => {
    const t = decodeText(bytes);
    const all = parseCsv(t.text.replace(/^﻿/, ''), MAX_ROWS + 1);
    const width = Math.max(1, ...all.map((r) => r.length));
    return { rows: all.slice(0, MAX_ROWS), columns: Math.min(width, MAX_COLUMNS), cut: t.cut || all.length > MAX_ROWS || width > MAX_COLUMNS };
  }, [bytes]);
  const [head, ...body] = rows;
  const cells = Array.from({ length: columns }, (_, i) => i);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {cut && <Notice>Showing the first {rows.length} rows{columns === MAX_COLUMNS ? ` and ${MAX_COLUMNS} columns` : ''}. Save the file to see all of it.</Notice>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-sm text-ink">
          {head && (
            <thead className="sticky top-0 bg-raised">
              <tr>{cells.map((i) => <th key={i} scope="col" dir="auto" className="border border-line px-3 py-2 text-left font-semibold whitespace-nowrap">{head[i] ?? ''}</th>)}</tr>
            </thead>
          )}
          <tbody>
            {body.map((r, n) => (
              <tr key={n} className="odd:bg-raised/50">{cells.map((i) => <td key={i} dir="auto" className="max-w-80 truncate border border-line px-3 py-1.5" title={r[i]}>{r[i] ?? ''}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Pdf = import('./pdf').PdfDocument;

function PdfPreview({ bytes, onError }: { bytes: Uint8Array; onError: (m: string) => void }) {
  const [pdf, setPdf] = useState<Pdf | null>(null);
  useEffect(() => {
    let alive = true;
    let opened: Pdf | null = null;
    // Loaded on first use: most people never open a PDF here.
    import('./pdf')
      .then((m) => m.openPdf(bytes))
      .then(
        (d) => {
          opened = d;
          if (alive) setPdf(d);
          else d.close();
        },
        (e: unknown) => alive && onError((e as { name?: string }).name === 'PasswordException' ? 'This PDF is protected with a password. Save it to open it in another app.' : 'This PDF could not be shown.'),
      );
    return () => {
      alive = false;
      opened?.close();
    };
  }, [bytes]);
  if (!pdf) return <div aria-busy="true" className="m-4 h-40 animate-pulse rounded-xl bg-raised" />;
  return (
    <div aria-label="PDF pages" className="min-h-0 flex-1 space-y-3 overflow-auto bg-line/40 p-3">
      {Array.from({ length: pdf.pages }, (_, i) => <PdfPage key={i} pdf={pdf} number={i + 1} />)}
    </div>
  );
}

/** A page is drawn when it comes near the screen and its canvas is freed when it leaves, so long documents stay cheap. */
function PdfPage({ pdf, number }: { pdf: Pdf; number: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(number === 1);
  const [ratio, setRatio] = useState(pdf.firstPageRatio);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const seen = new IntersectionObserver(([e]) => setNear(!!e?.isIntersecting), { rootMargin: '100% 0px' });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  useEffect(() => {
    const el = box.current;
    if (!near || !el) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'block h-full w-full';
    const page = pdf.draw(number, canvas, el.clientWidth * Math.min(2, window.devicePixelRatio || 1));
    page.ratio.then(setRatio, () => undefined);
    el.replaceChildren(canvas);
    return () => {
      page.cancel();
      el.replaceChildren();
    };
  }, [near, pdf, number]);
  return <div ref={box} role="img" aria-label={`Page ${number} of ${pdf.pages}`} style={{ aspectRatio: ratio }} className="mx-auto w-full max-w-3xl bg-white shadow-md" />;
}

/** Shown instead of downloading a large file right away. */
export function PreviewGate({ size, onOpen, children }: { size: number; onOpen: () => void; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {children}
      <div className="flex justify-center pb-8">
        <button type="button" onClick={onOpen} className={buttonClass.plain}>
          <Eye aria-hidden className="size-4" /> Show preview ({formatBytes(size)})
        </button>
      </div>
    </div>
  );
}

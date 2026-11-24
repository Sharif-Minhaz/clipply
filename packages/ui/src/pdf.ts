/// <reference types="vite/client" />
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** Character maps (Chinese, Japanese and Korean PDFs) and decoders for scanned pages (JBIG2, JPEG 2000), all bundled. */
const FILES = Object.entries(
  import.meta.glob<string>(['../../../node_modules/pdfjs-dist/cmaps/*.bcmap', '../../../node_modules/pdfjs-dist/wasm/{jbig2,openjpeg,qcms_bg}.wasm'], { query: '?url&no-inline', import: 'default', eager: true }),
).map(([path, url]) => [path.slice(path.lastIndexOf('/') + 1), url] as const);
const URLS = new Map(FILES);

class BundledData {
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    const url = URLS.get(filename);
    if (!url) throw new Error(`${filename} is not bundled`);
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }
}

export interface PdfDocument {
  pages: number;
  /** width / height of page 1, so the list has its size before pages are drawn. */
  firstPageRatio: number;
  draw(page: number, canvas: HTMLCanvasElement, width: number): { ratio: Promise<number>; cancel: () => void };
  close(): void;
}

/** PDF.js, offline: no scripting, no forms, no network; missing fonts come from the system. */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const task = pdfjs.getDocument({
    // PDF.js takes the buffer over (it is moved to the worker), so it gets a copy.
    data: bytes.slice(),
    BinaryDataFactory: BundledData,
    // Only enable the lookups; BundledData ignores the address.
    cMapUrl: 'bundled/',
    wasmUrl: 'bundled/',
    useWorkerFetch: false,
    useSystemFonts: true,
    enableXfa: false,
  });
  const doc = await task.promise;
  const first = (await doc.getPage(1)).getViewport({ scale: 1 });
  return {
    pages: doc.numPages,
    firstPageRatio: first.width / first.height,
    draw(number, canvas, width) {
      let cancelled = false;
      let render: { cancel: () => void } | null = null;
      const ratio = (async () => {
        const page = await doc.getPage(number);
        const size = page.getViewport({ scale: 1 });
        if (cancelled) return size.width / size.height;
        const viewport = page.getViewport({ scale: Math.max(0.1, width / size.width) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const r = page.render({ canvas, viewport });
        render = r;
        // A cancelled or failed page stays blank; the others still show.
        await r.promise.catch(() => undefined);
        return size.width / size.height;
      })();
      return {
        ratio,
        cancel: () => {
          cancelled = true;
          render?.cancel();
        },
      };
    },
    close: () => void task.destroy(),
  };
}

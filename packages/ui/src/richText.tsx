import { useMemo } from 'react';

const DROP = 'script, iframe, frame, frameset, object, embed, applet, link, meta, base, form, input, button, select, textarea, noscript, template, portal, audio, video, source, track, dialog';
/** Attributes that navigate, load or run something. */
const DROP_ATTR = new Set(['href', 'xlink:href', 'action', 'formaction', 'ping', 'srcset', 'srcdoc', 'background', 'poster', 'data', 'autofocus', 'tabindex', 'contenteditable']);

/**
 * Copied HTML as a standalone document that can only be looked at. Cleaning it is the first of three layers:
 * it is then shown in an iframe whose sandbox allows nothing (no scripts, forms, navigation or access to the
 * app) under a CSP that loads nothing from the network, so a copied page cannot track that it was viewed.
 */
export function formattedDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(DROP).forEach((el) => el.remove());
  for (const el of doc.querySelectorAll('*')) {
    for (const { name, value } of [...el.attributes]) {
      const n = name.toLowerCase();
      if (n.startsWith('on') || DROP_ATTR.has(n) || (n === 'src' && !/^data:image\//i.test(value.trim()))) el.removeAttribute(name);
    }
  }
  const styles = [...doc.querySelectorAll('head style')].map((s) => s.outerHTML).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'"><meta name="color-scheme" content="light"><style>body{margin:0;padding:16px;background:#fff;color:#14232a;font:16px/1.6 system-ui,sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{border-collapse:collapse}pre{white-space:pre-wrap}a{color:#08707c;text-decoration:underline}</style>${styles}</head><body>${doc.body.innerHTML}</body></html>`;
}

export function RichText({ html }: { html: string }) {
  const doc = useMemo(() => formattedDocument(html), [html]);
  return <iframe title="Formatted text" sandbox="" referrerPolicy="no-referrer" srcDoc={doc} className="min-h-0 w-full flex-1 border-0 bg-white" />;
}

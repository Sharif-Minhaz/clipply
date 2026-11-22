import type { ClipKind } from '@clipply/shared-schemas';

/** Dedupe ignores line-ending and trailing-whitespace differences between platforms. */
export function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trimEnd();
}

export function isUrl(text: string): boolean {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return false;
  try {
    new URL(t);
    return true;
  } catch {
    return false;
  }
}

const CODE_SIGNALS = [
  /[{};]\s*$/m,
  /^\s*(import|export|from|const|let|var|function|def|class|return|if|for|while|#include|package|fn|pub)\b/m,
  /=>|::|\+\+|&&|\|\||===|!=/,
  /^( {2,}|\t)\S/m,
];

/** Cheap heuristic: multi-line text with at least two code signals. Display-only, so false positives are harmless. */
export function looksLikeCode(text: string): boolean {
  if (!text.includes('\n')) return false;
  return CODE_SIGNALS.filter((re) => re.test(text)).length >= 2;
}

export function classifyText(text: string): Extract<ClipKind, 'text' | 'url' | 'code'> {
  if (isUrl(text)) return 'url';
  if (looksLikeCode(text)) return 'code';
  return 'text';
}

/** Plain-text view of HTML for previews and search. Not a sanitizer; never render its output as HTML. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** RFC 9562 UUIDv7: time-ordered ids so item ids sort by creation. */
export function uuidv7(now: number = Date.now()): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

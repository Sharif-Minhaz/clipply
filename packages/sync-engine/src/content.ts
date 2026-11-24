import type { ClipKind, ItemMeta } from '@clipply/shared-schemas';

const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
};

/** Suggested name when the user saves an item: the original file name, else one matching the image type. */
export function saveFileName(meta: Pick<ItemMeta, 'kind' | 'mime' | 'file'>): string {
  if (meta.file?.name) return meta.file.name;
  if (meta.kind === 'image') return `image.${IMAGE_EXT[meta.mime.toLowerCase()] ?? 'png'}`;
  return 'clip.txt';
}

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

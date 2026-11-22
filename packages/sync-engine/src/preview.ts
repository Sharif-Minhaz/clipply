/**
 * Link previews (Open Graph image + title) for link items. Fetched by the device showing the item,
 * never synced. Each platform supplies the raw HTTP GET; redirects are followed here one hop at a time
 * so every hop passes the same public-address check.
 */

export interface LinkPreview {
  title?: string;
  image?: Uint8Array;
  imageMime?: string;
}

export interface PreviewResponse {
  status: number;
  /** Lower-case header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

/** One GET without following redirects; may stop reading after `maxBytes + 1` bytes (so oversize is detectable). */
export type PreviewGet = (url: string, maxBytes: number) => Promise<PreviewResponse>;

const MAX_HTML_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/**
 * http(s) URL on a public host, or null. Keeps previews from probing the local network (router admin
 * pages, localhost services). Literal addresses are checked; names are trusted to resolve publicly.
 */
export function publicHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (host.startsWith('[')) return null;
  if (!host.includes('.') || /\.(localhost|local|internal|lan|home\.arpa|intranet|corp)$/.test(host)) return null;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
    if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return null;
  }
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** Open Graph / Twitter card image and title from a page's HTML; relative image URLs resolve against `pageUrl`. */
export function parseOpenGraph(html: string, pageUrl: string): { title?: string; image?: string } {
  const meta = new Map<string, string>();
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const a of tag[0].matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      attrs.set(a[1]!.toLowerCase(), a[3] ?? a[4] ?? a[5] ?? '');
    }
    const key = (attrs.get('property') ?? attrs.get('name'))?.toLowerCase();
    const content = attrs.get('content');
    if (key && content && !meta.has(key)) meta.set(key, decodeEntities(content).trim());
  }
  const out: { title?: string; image?: string } = {};
  const title = meta.get('og:title') ?? meta.get('twitter:title') ?? /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];
  if (title?.trim()) out.title = decodeEntities(title).replace(/\s+/g, ' ').trim().slice(0, 200);
  const image = ['og:image', 'og:image:url', 'og:image:secure_url', 'twitter:image', 'twitter:image:src'].map((k) => meta.get(k)).find(Boolean);
  if (image) {
    try {
      out.image = new URL(image, pageUrl).toString();
    } catch {
      // Unusable image URL: title only.
    }
  }
  return out;
}

async function getFollowing(get: PreviewGet, start: URL, maxBytes: number): Promise<{ res: PreviewResponse; url: URL } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await get(url.toString(), maxBytes);
    if (res.status >= 300 && res.status < 400 && res.headers.location) {
      const next = publicHttpUrl(new URL(res.headers.location, url).toString());
      if (!next) return null;
      url = next;
      continue;
    }
    return res.status >= 200 && res.status < 300 ? { res, url } : null;
  }
  return null;
}

/** Fetches a page's Open Graph image and title. Null when the page has neither or cannot be fetched. */
export async function fetchLinkPreview(rawUrl: string, get: PreviewGet): Promise<LinkPreview | null> {
  const start = publicHttpUrl(rawUrl);
  if (!start) return null;
  const page = await getFollowing(get, start, MAX_HTML_BYTES);
  if (!page || !/text\/html|application\/xhtml/i.test(page.res.headers['content-type'] ?? '')) return null;
  const og = parseOpenGraph(new TextDecoder().decode(page.res.body), page.url.toString());
  const out: LinkPreview = og.title ? { title: og.title } : {};
  const imageUrl = og.image ? publicHttpUrl(og.image) : null;
  if (imageUrl) {
    const img = await getFollowing(get, imageUrl, MAX_IMAGE_BYTES).catch(() => null);
    const mime = img?.res.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
    if (img && mime && IMAGE_TYPES.has(mime) && img.res.body.length > 0 && img.res.body.length <= MAX_IMAGE_BYTES) {
      out.image = img.res.body;
      out.imageMime = mime;
    }
  }
  return out.title || out.image ? out : null;
}

/**
 * Per-session memo with a small concurrency limit, so a long list of links does not open dozens of
 * connections at once. Failures are remembered as "no preview" until the app restarts.
 */
export class LinkPreviewer {
  private readonly cache = new Map<string, Promise<LinkPreview | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly get: PreviewGet, private readonly maxEntries = 200, private readonly concurrency = 3) {}

  preview(url: string): Promise<LinkPreview | null> {
    const hit = this.cache.get(url);
    if (hit) {
      this.cache.delete(url);
      this.cache.set(url, hit);
      return hit;
    }
    const p = this.limited(() => fetchLinkPreview(url, this.get)).catch(() => null);
    this.cache.set(url, p);
    if (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((r) => this.waiting.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}

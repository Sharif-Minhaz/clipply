import { describe, expect, it, vi } from 'vitest';

import { fetchLinkPreview, LinkPreviewer, parseOpenGraph, publicHttpUrl, type PreviewGet, type PreviewResponse } from './preview';

const html = (body: string): PreviewResponse => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: new TextEncoder().encode(body) });
const png = (n = 4): PreviewResponse => ({ status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array(n).fill(1) });

function server(routes: Record<string, PreviewResponse>): PreviewGet & { calls: string[] } {
  const calls: string[] = [];
  const get: PreviewGet = async (url) => {
    calls.push(url);
    return routes[url] ?? { status: 404, headers: {}, body: new Uint8Array(0) };
  };
  return Object.assign(get, { calls });
}

describe('link previews', () => {
  it('accepts only public http(s) hosts', () => {
    expect(publicHttpUrl('https://github.com/a/b')?.hostname).toBe('github.com');
    for (const bad of ['ftp://x.com', 'http://localhost:3000', 'http://192.168.1.1/admin', 'http://10.0.0.5', 'http://127.0.0.1', 'http://[::1]/', 'http://router', 'http://nas.local', 'https://user:pw@x.com', 'not a url']) {
      expect(publicHttpUrl(bad), bad).toBeNull();
    }
  });

  it('parses Open Graph tags in any attribute order, with entities and relative URLs', () => {
    const og = parseOpenGraph(
      `<head><title>Fallback</title><meta content="/img/card.png?a=1&amp;b=2" property="og:image"><meta name='og:title' content='Clipply &mdash; &quot;sync&quot; &#x2713;'></head>`,
      'https://example.com/x/y',
    );
    expect(og).toEqual({ image: 'https://example.com/img/card.png?a=1&b=2', title: 'Clipply &mdash; "sync" ✓' });
    expect(parseOpenGraph('<title> Only\n title </title>', 'https://e.com')).toEqual({ title: 'Only title' });
  });

  it('fetches the page and its image, following public redirects only', async () => {
    const get = server({
      'https://t.co/abc': { status: 301, headers: { location: 'https://site.com/post' }, body: new Uint8Array(0) },
      'https://site.com/post': html('<meta property="og:image" content="https://cdn.site.com/i.png"><meta property="og:title" content="Post">'),
      'https://cdn.site.com/i.png': png(),
    });
    const p = await fetchLinkPreview('https://t.co/abc', get);
    expect(p).toMatchObject({ title: 'Post', imageMime: 'image/png' });
    expect(p?.image).toHaveLength(4);

    const evil = server({ 'https://evil.com/': { status: 302, headers: { location: 'http://192.168.0.1/' }, body: new Uint8Array(0) } });
    expect(await fetchLinkPreview('https://evil.com/', evil)).toBeNull();
    expect(evil.calls).toEqual(['https://evil.com/']);
  });

  it('drops SVG, oversize and private images but keeps the title', async () => {
    for (const [img, res] of [
      ['https://e.com/a.svg', { status: 200, headers: { 'content-type': 'image/svg+xml' }, body: new Uint8Array(3) }],
      ['https://e.com/big.png', png(3 * 1024 * 1024 + 1)],
      ['http://10.1.1.1/x.png', png()],
    ] as const) {
      const get = server({ 'https://e.com/': html(`<meta property="og:image" content="${img}"><meta property="og:title" content="T">`), [img]: res });
      expect(await fetchLinkPreview('https://e.com/', get)).toEqual({ title: 'T' });
    }
    expect(await fetchLinkPreview('https://e.com/', server({ 'https://e.com/': html('<p>nothing</p>') }))).toBeNull();
  });

  it('caches per URL and remembers failures', async () => {
    const get = vi.fn<PreviewGet>(async () => html('<meta property="og:title" content="Hi">'));
    const previewer = new LinkPreviewer(get);
    await Promise.all([previewer.preview('https://a.com/'), previewer.preview('https://a.com/')]);
    expect(get).toHaveBeenCalledTimes(1);
    get.mockRejectedValueOnce(new Error('offline'));
    expect(await previewer.preview('https://b.com/')).toBeNull();
    expect(await previewer.preview('https://b.com/')).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });
});

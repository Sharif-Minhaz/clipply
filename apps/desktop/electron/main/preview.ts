import type { PreviewGet } from '@clipply/sync-engine';

/** Plain GET for link previews: no redirects followed (the caller checks each hop), body read only up to the cap. */
export const previewGet: PreviewGet = async (url, maxBytes) => {
  const res = await fetch(url, {
    redirect: 'manual',
    credentials: 'omit',
    signal: AbortSignal.timeout(8_000),
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; ClipplyLinkPreview/1.0)', accept: 'text/html,application/xhtml+xml,image/*;q=0.8' },
  });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (res.body && (res.status < 300 || res.status >= 400)) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
      if (size > maxBytes) {
        await reader.cancel();
        break;
      }
    }
  } else {
    await res.body?.cancel();
  }
  const body = new Uint8Array(Math.min(size, maxBytes + 1));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= body.length) break;
    const part = c.subarray(0, body.length - offset);
    body.set(part, offset);
    offset += part.length;
  }
  return { status: res.status, headers, body };
};

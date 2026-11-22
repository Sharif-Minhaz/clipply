import { createHash } from 'node:crypto';

export interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

/**
 * Cloudinary request signature: SHA-1 of the alphabetically sorted `key=value` pairs joined
 * with `&`, followed by the API secret. Empty values, file, api_key, resource_type and
 * cloud_name are excluded (Cloudinary "Generating authentication signatures").
 */
export function signParams(params: Record<string, string | number | undefined>, secret: string): string {
  const EXCLUDED = new Set(['file', 'api_key', 'resource_type', 'cloud_name']);
  const base = Object.entries(params)
    .filter(([k, v]) => !EXCLUDED.has(k) && v !== undefined && v !== '')
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return createHash('sha1').update(base + secret).digest('hex');
}

const api = (cfg: CloudinaryConfig, action: string): string =>
  `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/raw/${action}`;

/**
 * Fields for a direct, signed upload of ciphertext as a *private raw* asset. The public_id is
 * chosen by the server and cannot be overwritten, so a client cannot clobber another object.
 */
export function uploadFields(cfg: CloudinaryConfig, publicId: string, nowSec: number): { uploadUrl: string; fields: Record<string, string> } {
  const params = { public_id: publicId, timestamp: nowSec, type: 'private', overwrite: 'false' };
  return {
    uploadUrl: api(cfg, 'upload'),
    fields: {
      public_id: publicId, timestamp: String(nowSec), type: 'private', overwrite: 'false',
      api_key: cfg.apiKey, signature: signParams(params, cfg.apiSecret),
    },
  };
}

/** Cloudinary signs its upload response over public_id + version; a match proves the upload. */
export function verifyUploadResponse(cfg: CloudinaryConfig, r: { public_id: string; version: number; signature: string }): boolean {
  const expected = signParams({ public_id: r.public_id, version: r.version }, cfg.apiSecret);
  return expected === r.signature;
}

/** Short-lived signed URL for a private raw asset (Cloudinary `private_download_url`). */
export function privateDownloadUrl(cfg: CloudinaryConfig, publicId: string, nowSec: number, ttlSec = 600): { url: string; expiresAt: number } {
  const expiresAt = nowSec + ttlSec;
  const params = { public_id: publicId, timestamp: nowSec, type: 'private', expires_at: expiresAt };
  const qs = new URLSearchParams({
    public_id: publicId, timestamp: String(nowSec), type: 'private', expires_at: String(expiresAt),
    api_key: cfg.apiKey, signature: signParams(params, cfg.apiSecret),
  });
  return { url: `${api(cfg, 'download')}?${qs}`, expiresAt: expiresAt * 1000 };
}

/** Deletes a private raw asset. "not found" counts as success (already gone). */
export async function destroy(cfg: CloudinaryConfig, publicId: string, nowSec: number, doFetch: typeof fetch = fetch): Promise<boolean> {
  const params = { public_id: publicId, timestamp: nowSec, type: 'private', invalidate: 'true' };
  const body = new URLSearchParams({
    public_id: publicId, timestamp: String(nowSec), type: 'private', invalidate: 'true',
    api_key: cfg.apiKey, signature: signParams(params, cfg.apiSecret),
  });
  const res = await doFetch(api(cfg, 'destroy'), { method: 'POST', body, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return false;
  const json = (await res.json()) as { result?: string };
  return json.result === 'ok' || json.result === 'not found';
}

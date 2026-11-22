import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { BlobDownloader, BlobUploader, StoredSession } from '@clipply/sync-engine';

import type { SecretStorage } from '../vault';

/** Multipart POST of ciphertext straight to Cloudinary with the server-signed fields. */
export const uploadBlob: BlobUploader = async (uploadUrl, fields, ciphertext) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([ciphertext as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), 'clip');
  const res = await fetch(uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`blob upload failed (${res.status}): ${await cloudinaryError(res)}`);
  return z.object({ public_id: z.string(), version: z.number(), signature: z.string(), bytes: z.number() }).parse(await res.json());
};

/** Cloudinary explains rejections in `{ error: { message } }`; it never contains the (encrypted) content. */
async function cloudinaryError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    return (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

export const downloadBlob: BlobDownloader = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`blob download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
};

const Session = z.object({
  userId: z.string(), email: z.string(), refreshToken: z.string(), accessToken: z.string(), accessExpiresAt: z.number(),
});

/** The account session, sealed by the OS keyring like the vault (refresh tokens are credentials). */
export function sessionStore(storage: SecretStorage, path: string) {
  return {
    async load(): Promise<StoredSession | null> {
      if (!existsSync(path)) return null;
      try {
        const { result } = await storage.decryptStringAsync(readFileSync(path));
        return Session.parse(JSON.parse(result));
      } catch {
        return null;
      }
    },
    async save(s: StoredSession | null): Promise<void> {
      if (!s) {
        rmSync(path, { force: true });
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(`${path}.tmp`, await storage.encryptStringAsync(JSON.stringify(s)), { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    },
  };
}

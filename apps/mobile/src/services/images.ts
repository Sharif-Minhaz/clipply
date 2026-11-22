import { MAX_THUMB_BYTES } from '@clipply/shared-schemas';

/**
 * Thumbnail + decoded pixels for an image, computed in the WebView (no extra native code).
 * Pixels are RGBA from canvas; they dedupe images within Android (desktop hashes BGRA, so the same
 * image captured on both platforms can appear twice — documented in android.md).
 */
export async function decodeImage(bytes: Uint8Array, mime: string): Promise<{ thumb: Uint8Array; pixels: Uint8Array } | null>;
/** `withPixels: false`: thumbnail only (a picked camera photo's RGBA would be hundreds of MB). */
export async function decodeImage(bytes: Uint8Array, mime: string, withPixels: false): Promise<{ thumb: Uint8Array } | null>;
export async function decodeImage(bytes: Uint8Array, mime: string, withPixels = true): Promise<{ thumb: Uint8Array; pixels?: Uint8Array } | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    let pixels: Uint8Array | undefined;
    if (withPixels) {
      const full = new OffscreenCanvas(bitmap.width, bitmap.height);
      const fctx = full.getContext('2d')!;
      fctx.drawImage(bitmap, 0, 0);
      pixels = new Uint8Array(fctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
    }
    // Busy, tall screenshots compress poorly: step quality, then size, down until the thumbnail fits.
    let thumb = new Uint8Array(0);
    for (const [width, quality] of [[320, 0.8], [320, 0.6], [240, 0.6], [180, 0.5], [120, 0.5]] as const) {
      const scale = Math.min(1, width / bitmap.width);
      const t = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
      t.getContext('2d')!.drawImage(bitmap, 0, 0, t.width, t.height);
      thumb = new Uint8Array(await (await t.convertToBlob({ type: 'image/jpeg', quality })).arrayBuffer());
      if (thumb.length <= MAX_THUMB_BYTES) break;
    }
    bitmap.close();
    return pixels ? { thumb, pixels } : { thumb };
  } catch {
    return null;
  }
}

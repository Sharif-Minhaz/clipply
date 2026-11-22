/**
 * Thumbnail + decoded pixels for an image, computed in the WebView (no extra native code).
 * Pixels are RGBA from canvas; they dedupe images within Android (desktop hashes BGRA, so the same
 * image captured on both platforms can appear twice — documented in android.md).
 */
export async function decodeImage(bytes: Uint8Array, mime: string): Promise<{ thumb: Uint8Array; pixels: Uint8Array } | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }));
    const full = new OffscreenCanvas(bitmap.width, bitmap.height);
    const fctx = full.getContext('2d')!;
    fctx.drawImage(bitmap, 0, 0);
    const pixels = new Uint8Array(fctx.getImageData(0, 0, bitmap.width, bitmap.height).data.buffer);
    const scale = Math.min(1, 320 / bitmap.width);
    const t = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale)));
    t.getContext('2d')!.drawImage(bitmap, 0, 0, t.width, t.height);
    const thumb = new Uint8Array(await (await t.convertToBlob({ type: 'image/jpeg', quality: 0.8 })).arrayBuffer());
    bitmap.close();
    return { thumb, pixels };
  } catch {
    return null;
  }
}

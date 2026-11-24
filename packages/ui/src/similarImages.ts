/** What of an image is compared: its shape and a 32×32 brightness map. */
export interface ImageMark {
  id: string;
  ratio: number;
  gray: Uint8Array;
}

const SIZE = 32;

/** Average brightness per cell; `rgba` is `width`×`height` pixels. */
export function brightnessMap(rgba: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const out = new Uint8Array(SIZE * SIZE);
  for (let cy = 0; cy < SIZE; cy++) {
    const y0 = Math.floor((cy * height) / SIZE);
    const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / SIZE));
    for (let cx = 0; cx < SIZE; cx++) {
      const x0 = Math.floor((cx * width) / SIZE);
      const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / SIZE));
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          sum += rgba[i]! * 0.299 + rgba[i + 1]! * 0.587 + rgba[i + 2]! * 0.114;
        }
      }
      out[cy * SIZE + cx] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
    }
  }
  return out;
}

/** Reads a thumbnail (never the full image) in the browser; null when it cannot be decoded. */
export async function markImage(id: string, thumb: Uint8Array): Promise<ImageMark | null> {
  try {
    const bitmap = await createImageBitmap(new Blob([thumb as Uint8Array<ArrayBuffer>]));
    const { width, height } = bitmap;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    // Transparent images compare as they are shown, on white.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { id, ratio: width / height, gray: brightnessMap(ctx.getImageData(0, 0, width, height).data, width, height) };
  } catch {
    return null;
  }
}

const MAX_MEAN = 2.5;
/**
 * The 10th most different cell may differ this much. Measured: the same picture at another size or quality
 * stays at 7 or below, two pages that differ in one line of text reach 16.
 */
const MAX_CELL = 10;

export function looksSame(a: ImageMark, b: ImageMark): boolean {
  if (Math.abs(a.ratio - b.ratio) / Math.max(a.ratio, b.ratio) > 0.015) return false;
  let sum = 0;
  let far = 0;
  for (let i = 0; i < a.gray.length; i++) {
    const d = Math.abs(a.gray[i]! - b.gray[i]!);
    sum += d;
    if (d > MAX_CELL && ++far >= 10) return false;
  }
  return sum / a.gray.length <= MAX_MEAN;
}

/** Groups of ids whose images look the same, in the order the marks came in. Each is compared with a group's first image, so a chain of small changes cannot join two different ones. */
export function groupSimilarImages(marks: readonly ImageMark[]): string[][] {
  const groups: Array<{ first: ImageMark; ids: string[] }> = [];
  for (const m of marks) {
    const g = groups.find((x) => looksSame(x.first, m));
    if (g) g.ids.push(m.id);
    else groups.push({ first: m, ids: [m.id] });
  }
  return groups.filter((g) => g.ids.length > 1).map((g) => g.ids);
}

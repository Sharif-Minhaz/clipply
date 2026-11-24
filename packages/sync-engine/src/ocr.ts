import { OCR_SCRIPT, type OcrLanguage } from '@clipply/shared-schemas';

/** One Tesseract pass over an image. */
export interface OcrScan {
  text: string;
  /** Page confidence, 0–100. */
  confidence: number;
  words: ReadonlyArray<{ text: string; confidence: number }>;
}

/** A pass that reads this well is right; measured, the wrong language stays below 60. */
const SURE = 85;

/**
 * True when a word in the language's script was read with confidence. Tesseract also turns noise and blurry
 * Latin into other scripts, but in measurements those words were single letters or stayed below 70.
 */
export const hasScript = (language: OcrLanguage, scan: Pick<OcrScan, 'words'>): boolean =>
  scan.words.some((w) => w.confidence >= 80 && OCR_SCRIPT[language].test(w.text));

/**
 * One pass per language (each with English) and the best one wins. All languages in a single pass read
 * worse: with Bengali first, Tesseract turned Arabic words into Bengali digits.
 * `language` is the one whose script was found; null means Latin text only (or none).
 */
export async function scanLanguages(
  languages: readonly OcrLanguage[],
  scan: (tesseractLanguages: string[]) => Promise<OcrScan>,
): Promise<OcrScan & { language: OcrLanguage | null }> {
  if (languages.length === 0) return { ...(await scan(['eng'])), language: null };
  let best: (OcrScan & { language: OcrLanguage | null }) | null = null;
  for (const l of languages) {
    // English last: as the primary language it reads other scripts as Latin.
    const s = await scan([l, 'eng']);
    const found = { ...s, language: hasScript(l, s) ? l : null };
    if (found.language && s.confidence >= SURE) return found;
    if (!best || s.confidence > best.confidence) best = found;
  }
  return best!;
}

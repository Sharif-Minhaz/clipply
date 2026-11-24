import { z } from 'zod';

/** Languages text recognition can read besides English, which is always on. All are bundled; nothing is downloaded. */
export const OcrLanguage = z.enum(['ben', 'ara', 'hin', 'jpn']);
export type OcrLanguage = z.infer<typeof OcrLanguage>;

export const OCR_LANGUAGE_LABEL: Record<OcrLanguage, string> = { ben: 'Bengali', ara: 'Arabic', hin: 'Hindi', jpn: 'Japanese' };

/** What text in each language looks like. Two letters in a row where one misread shape is common; Japanese words can be one. */
export const OCR_SCRIPT: Record<OcrLanguage, RegExp> = {
  ben: /\p{Script=Bengali}{2}/u,
  ara: /\p{Script=Arabic}{2}/u,
  hin: /\p{Script=Devanagari}{2}/u,
  jpn: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
};

/** Each language adds a scan, so only Bengali is on until the user adds more. */
export const DEFAULT_OCR_LANGUAGES: readonly OcrLanguage[] = ['ben'];
export const OcrLanguages = z.array(OcrLanguage).max(4).transform((l) => OcrLanguage.options.filter((x) => l.includes(x)));

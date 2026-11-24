import { OCR_LANGUAGE_LABEL, OcrLanguage } from '@clipply/shared-schemas';

import { SwitchRow } from './settings';

/** Which scripts text recognition looks for. The language data is in the app; nothing is downloaded. */
export function OcrLanguageRows({ value, onChange }: { value: readonly OcrLanguage[]; onChange: (v: OcrLanguage[]) => void }) {
  return (
    <>
      {OcrLanguage.options.map((l) => (
        <SwitchRow key={l} label={OCR_LANGUAGE_LABEL[l]} checked={value.includes(l)} onChange={(on) => onChange(OcrLanguage.options.filter((x) => (x === l ? on : value.includes(x))))} />
      ))}
    </>
  );
}

export const OCR_LANGUAGES_NOTE = 'English is always read. Each language adds a pass over the image, so a scan takes longer. Everything runs on this device.';

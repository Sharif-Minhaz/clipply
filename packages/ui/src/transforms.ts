import { stripTracking } from '@clipply/sync-engine/links';

/** Quick edits offered in the text viewer. Each returns the new text; `Error` messages are shown to the user. */
export interface TextTransform {
  id: string;
  label: string;
  apply: (text: string) => string;
}

function json(text: string, indent?: number): string {
  try {
    return JSON.stringify(JSON.parse(text), null, indent);
  } catch {
    throw new Error('This is not valid JSON.');
  }
}

export const TRANSFORMS: readonly TextTransform[] = [
  { id: 'trim', label: 'Trim spaces and blank lines', apply: (t) => t.split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim() },
  { id: 'join', label: 'Join lines', apply: (t) => t.replace(/\s*\n\s*/g, ' ').trim() },
  { id: 'upper', label: 'UPPERCASE', apply: (t) => t.toUpperCase() },
  { id: 'lower', label: 'lowercase', apply: (t) => t.toLowerCase() },
  { id: 'title', label: 'Title Case', apply: (t) => t.toLowerCase().replace(/(^|[\s\-_/("'[])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase()) },
  { id: 'json', label: 'Format JSON', apply: (t) => json(t, 2) },
  { id: 'json-min', label: 'Minify JSON', apply: (t) => json(t) },
  { id: 'untrack', label: 'Remove link tracking', apply: stripTracking },
];

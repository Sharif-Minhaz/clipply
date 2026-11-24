/** Quick edits offered in the text viewer. Each returns the new text; `Error` messages are shown to the user. */
export interface TextTransform {
  id: string;
  label: string;
  apply: (text: string) => string;
}

const TRACKING_PARAM = /^(utm_\w+|fbclid|gclid|gbraid|wbraid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi|mkt_tok)$/i;
// `si` is a share-tracking id on these hosts only; elsewhere it may be a real parameter.
const SI_HOSTS = /(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/i;

function isTracking(pair: string, host: string): boolean {
  let key: string;
  try {
    key = decodeURIComponent(pair.split('=')[0]!.replace(/\+/g, ' '));
  } catch {
    return false;
  }
  return TRACKING_PARAM.test(key) || (key === 'si' && SI_HOSTS.test(host));
}

/** Removes known tracking parameters from every http(s) link; other parameters keep their exact encoding. */
export function stripTracking(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"'`]+/g, (match) => {
    // Sentence punctuation right after a link is not part of it.
    const [, raw = match, tail = ''] = /^(.*?)([).,;:!?\]]*)$/.exec(match) ?? [];
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return match;
    }
    const pairs = url.search.slice(1).split('&').filter(Boolean);
    const kept = pairs.filter((p) => !isTracking(p, url.hostname));
    if (kept.length === pairs.length) return match;
    url.search = kept.length ? `?${kept.join('&')}` : '';
    return url.toString() + tail;
  });
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

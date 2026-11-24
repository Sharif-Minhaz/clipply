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

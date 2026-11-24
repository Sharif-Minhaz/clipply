const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—',
  hellip: '…', bull: '•', middot: '·', copy: '©', reg: '®', trade: '™', euro: '€', times: '×', laquo: '«', raquo: '»',
};

/** One pass, so text that spells an entity (`&amp;lt;`) comes out as written. */
const decode = (t: string): string =>
  t.replace(/&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|([a-z]{2,6}));/gi, (all, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return NAMED[name.toLowerCase()] ?? all;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : all;
  });

/** In <pre>, spaces and line breaks of the source are content. */
const keepPre = (html: string): string =>
  html.replace(/<pre\b[^<>]*>[\s\S]*?(?:<\/pre\s*>|$)/gi, (pre) =>
    pre.replace(/<[^<>]*>|[^<]+|</g, (part) => (part.startsWith('<') ? part : part.replace(/\r?\n/g, '<br>').replace(/[ \t]/g, '&nbsp;'))),
  );

// Boundaries a browser shows as a new line / a blank line; they collapse where they meet.
const LINE = '\u0001';
const PARAGRAPH = '\u0002';

/**
 * Plain-text view of HTML with its line structure, for previews, search and pasting. Not a sanitizer; never
 * render its output as HTML. Every step is linear, unclosed tags included: any web page can put HTML on the clipboard.
 */
export function htmlToText(html: string): string {
  const flat = keepPre(html.replace(/[\u0001\u0002]/g, ''))
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|title)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<\/t[dh]\s*>\s*(?=<t[dh]\b)/gi, '\t')
    .replace(/<br\b[^<>]*>/gi, '\n')
    .replace(/<li\b[^<>]*>/gi, `${LINE}- `)
    .replace(/<\/?(p|h[1-6]|ul|ol|dl|table|blockquote|pre|hr|figure)\b[^<>]*>/gi, PARAGRAPH)
    .replace(/<\/?(div|li|tr|dt|dd|section|article|header|footer|main|aside|nav|address|figcaption|caption)\b[^<>]*>/gi, LINE)
    .replace(/<[^<>]+>/g, '')
    .replace(/[ \u0001\u0002]+/g, (run) => (run.includes(PARAGRAPH) ? '\n\n' : run.includes(LINE) ? '\n' : ' '))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return decode(flat)
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .trim();
}

/**
 * True when HTML says more than its plain text: emphasis, links, lists, tables, headings, images. Browsers and
 * editors put HTML next to every copy; a styled span or syntax colours alone are not worth a rich-text clip.
 */
export function hasFormatting(html: string): boolean {
  const body = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<(script|style|head)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, '')
    // Google Docs wraps every copy in a <b> that is not bold.
    .replace(/<b\b[^<>]*font-weight:\s*normal[^<>]*>/gi, '');
  return (
    /<(b|strong|i|em|u|s|strike|del|mark|sub|sup|ul|ol|table|blockquote|h[1-6])(\s[^<>]*)?>/i.test(body) ||
    /<a\s[^<>]*?href=/i.test(body) ||
    /<img\s/i.test(body) ||
    /font-weight:\s*(bold|[6-9]00)/i.test(body)
  );
}

import type { ClipKind } from '@clipply/shared-schemas';

import { stripTracking } from './links';

export interface TextEntry {
  id: string;
  kind: ClipKind;
  text: string;
}

const SHINGLE = 5;
/** Shorter texts must be equal once case, spacing and punctuation are ignored: one letter can change their meaning. */
const MIN_FUZZY_CHARS = 80;
/** Only the start of a very long text is compared letter by letter. */
const MAX_FUZZY_CHARS = 20_000;
const MIN_SIMILARITY = 0.9;
/** Texts sharing one of their smallest hashes are compared; similar texts nearly always share some. */
const CANDIDATE_HASHES = 6;

const squash = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** Texts with the same key read the same. */
function sameKey({ kind, text }: TextEntry): string {
  const flat = squash(text.normalize('NFKC'));
  if (kind === 'url') {
    try {
      const u = new URL(stripTracking(flat));
      return `url:${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}${u.search}${u.hash}`;
    } catch {
      return `url:${flat}`;
    }
  }
  // Code, and single tokens (passwords, ids): case and punctuation matter.
  if (kind === 'code' || !flat.includes(' ')) return `exact:${flat}`;
  const words = flat.toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim();
  return words ? `words:${words}` : `exact:${flat}`;
}

function shingles(text: string): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + SHINGLE <= text.length; i++) {
    // FNV-1a
    let h = 0x811c9dc5;
    for (let j = i; j < i + SHINGLE; j++) h = Math.imul(h ^ text.charCodeAt(j), 0x01000193);
    out.add(h >>> 0);
  }
  return out;
}

function smallest(set: ReadonlySet<number>, n: number): number[] {
  const low: number[] = [];
  for (const h of set) {
    if (low.length < n) low.push(h);
    else {
      const max = Math.max(...low);
      if (h < max) low[low.indexOf(max)] = h;
    }
  }
  return low;
}

function similarity(a: ReadonlySet<number>, b: ReadonlySet<number>): number {
  let shared = 0;
  for (const h of a) if (b.has(h)) shared++;
  return shared / (a.size + b.size - shared);
}

const digits = (t: string): string => t.replace(/\P{Nd}+/gu, '');

/**
 * Groups of texts that say the same thing: equal apart from case, spacing and punctuation, or long and at
 * least 90 % alike with the same numbers in them (two invoices or two codes are never "the same").
 */
export async function groupSimilarTexts(entries: readonly TextEntry[]): Promise<string[][]> {
  const parent = new Map<string, string>(entries.map((e) => [e.id, e.id]));
  const root = (id: string): string => {
    let r = id;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(id, r);
    return r;
  };
  const join = (a: string, b: string): void => void parent.set(root(b), root(a));

  const byKey = new Map<string, string>();
  const fuzzy: Array<{ id: string; length: number; set: Set<number>; digits: string }> = [];
  for (const e of entries) {
    const key = sameKey(e);
    const first = byKey.get(key);
    if (first !== undefined) {
      join(first, e.id);
      continue;
    }
    byKey.set(key, e.id);
    const flat = squash(e.text.normalize('NFKC'));
    if (e.kind === 'url' || flat.length < MIN_FUZZY_CHARS) continue;
    const part = (e.kind === 'code' ? flat : flat.toLowerCase()).slice(0, MAX_FUZZY_CHARS);
    fuzzy.push({ id: e.id, length: flat.length, set: shingles(part), digits: digits(flat) });
    // Keep the app responsive: this shares a thread with everything else.
    if (fuzzy.length % 50 === 0) await new Promise((r) => setTimeout(r));
  }

  const buckets = new Map<number, number[]>();
  for (const [i, e] of fuzzy.entries()) {
    const seen = new Set<number>();
    for (const h of smallest(e.set, CANDIDATE_HASHES)) {
      const bucket = buckets.get(h) ?? [];
      for (const j of bucket) seen.add(j);
      bucket.push(i);
      buckets.set(h, bucket);
    }
    for (const j of seen) {
      const o = fuzzy[j]!;
      if (root(o.id) === root(e.id) || o.digits !== e.digits) continue;
      if (Math.min(o.length, e.length) / Math.max(o.length, e.length) < MIN_SIMILARITY) continue;
      if (similarity(o.set, e.set) >= MIN_SIMILARITY) join(o.id, e.id);
    }
    if (i % 200 === 199) await new Promise((r) => setTimeout(r));
  }

  const groups = new Map<string, string[]>();
  for (const e of entries) {
    const r = root(e.id);
    groups.set(r, [...(groups.get(r) ?? []), e.id]);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

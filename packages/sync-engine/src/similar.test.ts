// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ClipKind } from '@clipply/shared-schemas';

import { groupSimilarTexts } from './similar';

const group = async (...list: Array<string | [ClipKind, string]>): Promise<string[][]> =>
  groupSimilarTexts(list.map((x, i) => ({ id: String(i), kind: Array.isArray(x) ? x[0] : 'text', text: Array.isArray(x) ? x[1] : x })));

const PARAGRAPH = 'The quarterly report is almost finished, and the team would like everyone to read it carefully before the meeting next week in the main office.';

describe('groupSimilarTexts', () => {
  it('ignores case, spacing and punctuation', async () => {
    expect(await group('Hello, world!', 'hello   world', 'Goodbye world')).toEqual([['0', '1']]);
    expect(await group('আমি বাংলায় গান গাই।', 'আমি  বাংলায় গান গাই')).toEqual([['0', '1']]);
  });

  it('keeps apart what one character changes', async () => {
    expect(await group('01711111111', '01711111112')).toEqual([]);
    expect(await group('Passw0rd!', 'passw0rd')).toEqual([]);
    expect(await group(['code', 'const a = b - c;'], ['code', 'const a = b + c;'])).toEqual([]);
    expect(await group(`${PARAGRAPH} Invoice 1042.`, `${PARAGRAPH} Invoice 1043.`)).toEqual([]);
  });

  it('treats a link as the same without tracking or a trailing slash, but not another path or query', async () => {
    expect(await group(['url', 'https://a.com/x?utm_source=mail'], ['url', 'https://A.com/x/'], ['url', 'https://a.com/y'], ['url', 'https://a.com/x?id=1'])).toEqual([['0', '1']]);
  });

  it('finds long texts with small edits, also among many others', async () => {
    const others = Array.from({ length: 300 }, (_, i) => `Unrelated note ${'abcdefghij'[i % 10]!.repeat(3)} ${String.fromCharCode(97 + (i % 26)).repeat(5 + (i % 40))} talks about something else entirely, see ${i}.`);
    const found = await group(PARAGRAPH, PARAGRAPH.replace('almost finished', 'almost finishing'), `${PARAGRAPH} And then much more was added to it, so that it is clearly a different, longer text than before.`, ...others);
    expect(found).toContainEqual(['0', '1']);
    expect(found.flat()).not.toContain('2');
  });
});

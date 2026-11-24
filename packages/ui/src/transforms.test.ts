import { describe, expect, it } from 'vitest';

import { stripTracking, TRANSFORMS } from './transforms';

const run = (id: string, text: string): string => TRANSFORMS.find((t) => t.id === id)!.apply(text);

describe('text transforms', () => {
  it('removes tracking parameters and keeps the rest of the link exactly', () => {
    expect(stripTracking('see https://shop.example/p?id=4&utm_source=news&q=a%20b#top.')).toBe('see https://shop.example/p?id=4&q=a%20b#top.');
    expect(stripTracking('(https://x.example/a?fbclid=1)')).toBe('(https://x.example/a)');
    expect(stripTracking('https://youtu.be/abc?si=xyz&t=10')).toBe('https://youtu.be/abc?t=10');
    // `si` elsewhere, and links without tracking, are untouched.
    expect(stripTracking('https://example.com/a?si=1 and http://example.com')).toBe('https://example.com/a?si=1 and http://example.com');
  });

  it('cases, trims, joins and formats', () => {
    expect(run('title', 'hello wORLD-wide (web)')).toBe('Hello World-Wide (Web)');
    expect(run('trim', '  a  \n\n\n\nb\t\n')).toBe('a\n\nb');
    expect(run('join', 'one\n  two\r\nthree')).toBe('one two three');
    expect(run('json', '{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(run('json-min', '{ "a": 1 }')).toBe('{"a":1}');
    expect(() => run('json', 'not json')).toThrow('This is not valid JSON.');
  });
});

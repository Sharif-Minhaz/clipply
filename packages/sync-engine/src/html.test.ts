// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hasFormatting, htmlToText } from './html';

describe('htmlToText', () => {
  it('keeps lines, paragraphs, lists and table cells', () => {
    expect(htmlToText('<p>One</p>\n<p>Two<br>three</p>')).toBe('One\n\nTwo\nthree');
    expect(htmlToText('<div>a</div><div>b</div><div><br></div><div>c</div>')).toBe('a\nb\n\nc');
    expect(htmlToText('<p>List:</p><ul><li>one</li><li>two</li></ul><p>end</p>')).toBe('List:\n\n- one\n- two\n\nend');
    expect(htmlToText('<table><tr><td>A</td> <td>B</td></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('A\tB\n1\t2');
    expect(htmlToText('un<b>believ</b>able  \n  text')).toBe('unbelievable text');
  });

  it('keeps code layout, drops scripts, and decodes entities once', () => {
    expect(htmlToText('<pre><code>if (x) {\n  run();\n}</code></pre>')).toBe('if (x) {\n  run();\n}');
    expect(htmlToText('<style>p{}</style><script>x()</script>Hi<!-- no -->')).toBe('Hi');
    expect(htmlToText('&amp;lt; &#8217;&#x1F600; &rsquo; &bogus; &#xD800;')).toBe('&lt; ’😀 ’ &bogus; &#xD800;');
  });
});

describe('hostile HTML', () => {
  it('is read in linear time', () => {
    const start = performance.now();
    for (const part of ['<div>', '<script>', '<pre>', '<!--', '<', '<br ', '<b ', '<a ', '<p> ', '</td><td']) {
      const html = part.repeat(Math.floor(400_000 / part.length));
      htmlToText(html);
      hasFormatting(html);
    }
    // Quadratic versions took seconds per case.
    expect(performance.now() - start).toBeLessThan(3_000);
  });

  it('treats unclosed blocks like a browser does', () => {
    expect(htmlToText('seen<script>hidden')).toBe('seen');
    expect(htmlToText('seen<!-- hidden')).toBe('seen');
    expect(htmlToText('a < b and c')).toBe('a < b and c');
  });
});

describe('hasFormatting', () => {
  it('sees formatting a reader would miss', () => {
    for (const h of ['<b>x</b>', '<p>see <a href="https://a.b">this</a></p>', '<ul><li>x</li></ul>', '<h2 class="t">x</h2>', '<table><tr><td>1</td></tr></table>', '<img src="x">', '<span style="font-weight: 700">x</span>']) {
      expect(hasFormatting(h), h).toBe(true);
    }
  });

  it('ignores what browsers and editors add to every copy', () => {
    for (const h of [
      '<meta charset="utf-8"><span style="color: rgb(0,0,0); font-weight: 400">plain</span>',
      '<div style="color:#d4d4d4"><div><span style="color:#569cd6">const</span> x</div></div>',
      '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1"><span>Docs</span></b>',
      '<head><style>b{}</style><title>t</title></head><body>plain<br>lines</body>',
      '<body>plain <section>x</section></body>',
    ]) {
      expect(hasFormatting(h), h).toBe(false);
    }
  });
});

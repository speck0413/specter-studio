// An extension's SVG icon keeps its shapes and loses everything that could run, load or style the page.
import { describe, expect, it } from 'vitest';
import { MAX_SVG_BYTES, sanitizeSvg } from './svg';

describe('sanitizeSvg', () => {
  it('keeps shapes, geometry and paint', () => {
    const s = sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 24 24"><g transform="rotate(10)"><path d="M1 1h10v10z" fill="#c00" fill-rule="evenodd"/><circle cx="5" cy="5" r="2" stroke="currentColor" stroke-width="1.5"/></g></svg>')!;
    expect(s).toContain('<path');
    expect(s).toContain('d="M1 1h10v10z"');
    expect(s).toContain('fill="#c00"');
    expect(s).toContain('viewBox="0 0 24 24"');
    expect(s).toContain('transform="rotate(10)"');
    expect(s).not.toMatch(/width="48"/);
  });

  it('drops scripts, handlers, links, styles, foreign content and url() values', () => {
    const s = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" onload="alert(1)" style="background:url(http://x)">
      <script>alert(1)</script><style>*{fill:red}</style><foreignObject><div>hi</div></foreignObject>
      <a href="javascript:alert(1)"><path d="M0 0h1"/></a><image href="http://x/y.png"/><use xlink:href="#p"/>
      <path id="p" d="M0 0h24v24z" onclick="x()" fill="url(#g)" style="fill:red" stroke="javascript:x"/></svg>`)!;
    expect(s).toBeTruthy();
    for (const bad of ['script', 'alert', 'style', 'foreignObject', 'onload', 'onclick', 'href', 'url(', 'image', '<use', '<a ', 'javascript']) expect(s).not.toContain(bad);
    expect(s).toContain('d="M0 0h24v24z"');
  });

  it('refuses what is not an SVG with a shape, entities and oversized files', () => {
    expect(sanitizeSvg('<html><body>x</body></html>')).toBeNull();
    expect(sanitizeSvg('<svg><title>empty</title></svg>')).toBeNull();
    expect(sanitizeSvg('<svg><path d="M0 0"')).toBeNull();
    expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY x "y">]><svg><path d="M0 0h1"/></svg>')).toBeNull();
    expect(sanitizeSvg(`<svg><path d="M0 0h1"/>${' '.repeat(MAX_SVG_BYTES)}</svg>`)).toBeNull();
    expect(sanitizeSvg(42 as any)).toBeNull();
  });
});

// An extension's SVG icon made safe to draw inside Studio's own page: shapes only. Kept: svg, g, path, circle,
// ellipse, rect, line, polyline, polygon, title, with their geometry, fill and stroke. Gone: scripts, styles,
// links, images, foreign objects, `use`, gradients and filters, event handlers, and any value with `url(`,
// `javascript:` or an entity. Anything that does not parse as SVG gives null.

/** The largest icon file Studio reads (core plugins.rs keeps to the same). */
export const MAX_SVG_BYTES = 32 * 1024;

const ELEMENTS = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'title']);
const GEOMETRY = new Set(['viewbox', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'points', 'transform', 'width', 'height']);
const PAINT = new Set(['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule', 'opacity', 'fill-opacity', 'stroke-opacity']);
const SAFE_PAINT = /^(none|currentcolor|#[0-9a-f]{3,8}|[a-z]+|rgba?\([\d\s.,%]+\)|[\d.]+%?|round|butt|square|miter|bevel|evenodd|nonzero)$/i;
const SAFE_GEOMETRY = /^[-\d\s.,eE+a-zA-Z()]*$/;

export function sanitizeSvg(markup: string): string | null {
  if (typeof markup !== 'string' || !markup.trim() || markup.length > MAX_SVG_BYTES) return null;
  if (/<!ENTITY|<!DOCTYPE/i.test(markup)) return null;
  let doc: Document;
  try { doc = new DOMParser().parseFromString(markup, 'image/svg+xml'); } catch { return null; }
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length) return null;
  const NS = 'http://www.w3.org/2000/svg';
  const out = document.createElementNS(NS, 'svg');
  const copy = (from: Element, to: Element) => {
    for (const a of Array.from(from.attributes)) {
      const n = a.name.toLowerCase();
      const v = a.value;
      if (/url\(|javascript:|&|expression|@import/i.test(v)) continue;
      if (GEOMETRY.has(n) && SAFE_GEOMETRY.test(v)) to.setAttribute(n === 'viewbox' ? 'viewBox' : n, v);
      else if (PAINT.has(n) && SAFE_PAINT.test(v.trim())) to.setAttribute(n, v.trim());
    }
    for (const c of Array.from(from.childNodes)) {
      if (c.nodeType === 3 && to.nodeName.toLowerCase() === 'title') { to.appendChild(document.createTextNode(c.textContent || '')); continue; }
      if (c.nodeType !== 1) continue;
      const tag = (c as Element).localName.toLowerCase();
      if (!ELEMENTS.has(tag) || tag === 'svg') continue;
      const el = document.createElementNS(NS, tag);
      copy(c as Element, el);
      to.appendChild(el);
    }
  };
  copy(root, out);
  // drawn at the size of the place it is put in
  out.removeAttribute('width');
  out.removeAttribute('height');
  if (!out.getAttribute('viewBox')) out.setAttribute('viewBox', '0 0 24 24');
  out.setAttribute('xmlns', NS);
  out.setAttribute('aria-hidden', 'true');
  out.setAttribute('focusable', 'false');
  if (!out.querySelector('path,circle,ellipse,rect,line,polyline,polygon')) return null;
  return new XMLSerializer().serializeToString(out);
}

// An editor's hover help is seen whole: inside the window, and not cut off by the box the editor sits in.
// A bounding box is the full size even when a parent clips it, so each corner is checked for what is drawn there.
import { expect, Locator, Page } from '@playwright/test';

export async function expectWhollyVisible(hover: Locator) {
  const seen = await hover.evaluate((el) => {
    const root = el.closest('.monaco-resizable-hover') ?? el;
    const b = el.getBoundingClientRect();
    const corners = [[b.left + 4, b.top + 4], [b.right - 4, b.top + 4], [b.left + 4, b.bottom - 4], [b.right - 4, b.bottom - 4]];
    return {
      inWindow: b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight,
      corners: corners.map(([x, y]) => root.contains(document.elementFromPoint(x, y))),
    };
  });
  expect(seen).toEqual({ inWindow: true, corners: [true, true, true, true] });
}

/** Moves the mouse onto the first `word` shown in an editor (whatever the spans around it), for its hover help. */
export async function hoverWord(page: Page, editor: Locator, word: string) {
  await expect(editor.locator('.view-lines')).toContainText(word);
  const at = await editor.locator('.view-lines').evaluate((lines, w) => {
    const walk = document.createTreeWalker(lines, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const m = new RegExp(`\\b${w}\\b`).exec(n.textContent || '');
      if (!m) continue;
      const r = document.createRange();
      r.setStart(n, m.index); r.setEnd(n, m.index + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, word);
  expect(at, `“${word}” in the editor`).not.toBeNull();
  await page.mouse.move(at!.x, at!.y);
}

// Every theme reads well (WCAG AA 4.5:1 for text) and keeps its status colours apart.
import { describe, expect, it } from 'vitest';
import { clampZoom, contrast, hue, makeTheme, resolveTheme, SERIES, THEME_IDS, THEMES } from './theme';

const AA = 4.5;
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe.each(THEME_IDS)('theme %s', (id) => {
  const t = THEMES[id].tokens;
  const surfaces = { editor: t.editor, panel: t.panel, sideBar: t.sideBar };
  it('text and muted text on every surface', () => {
    for (const [n, bg] of Object.entries(surfaces)) {
      expect(contrast(t.text, bg), `text on ${n}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(t.textMuted, bg), `muted text on ${n}`).toBeGreaterThanOrEqual(AA);
    }
  });
  it('text and muted text on a selected or hovered row', () => {
    for (const [n, bg] of Object.entries({ selection: t.selection, hover: t.hover })) {
      expect(contrast(t.text, bg), `text on ${n}`).toBeGreaterThanOrEqual(AA);
      expect(contrast(t.textMuted, bg), `muted text on ${n}`).toBeGreaterThanOrEqual(AA);
    }
  });
  it('accent and status colours as text (links, text buttons, error lines)', () => {
    for (const [n, c] of Object.entries({ primary: t.primary, ok: t.ok, warn: t.warn, error: t.error, info: t.info })) {
      for (const [s, bg] of Object.entries(surfaces)) expect(contrast(c, bg), `${n} on ${s}`).toBeGreaterThanOrEqual(AA);
    }
  });
  it('text on the filled colours (contained buttons, chips)', () => {
    expect(contrast(t.primaryText, t.primary)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t.secondaryText, t.secondary)).toBeGreaterThanOrEqual(AA);
    for (const c of [t.ok, t.warn, t.error, t.info]) expect(contrast(t.onStatus, c), c).toBeGreaterThanOrEqual(AA);
  });
  it('the bars: activity bar labels and status bar text', () => {
    expect(contrast(t.activityFg, t.activityBar)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t.activityActive, t.activityBar)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t.statusFg, t.statusBar)).toBeGreaterThanOrEqual(AA);
    expect(contrast(t.text, t.titleBar)).toBeGreaterThanOrEqual(AA);
  });
  it('ok, warning and error stay apart; an output that is on stands out from one that is off', () => {
    const [ok, warn, err] = [hue(t.ok), hue(t.warn), hue(t.error)];
    expect(hueGap(ok, warn)).toBeGreaterThanOrEqual(30);
    expect(hueGap(warn, err)).toBeGreaterThanOrEqual(30);
    expect(hueGap(ok, err)).toBeGreaterThanOrEqual(60);
    expect(contrast(t.outputOn, t.panel), 'output on vs the tile').toBeGreaterThanOrEqual(3);
    expect(contrast(t.outputOn, t.outputOff), 'on vs off').toBeGreaterThanOrEqual(1.5);
  });
  it('plot lines show on the plot, and chip text on each line colour', () => {
    const s = SERIES[t.mode];
    for (const c of s.colors) {
      expect(contrast(c, t.editor), `${c} on the editor`).toBeGreaterThanOrEqual(3);
      expect(contrast(s.text, c), `chip text on ${c}`).toBeGreaterThanOrEqual(AA);
    }
  });
  it('builds an MUI theme at every text size', () => {
    for (const z of [70, 100, 200]) {
      const m = makeTheme(id, z);
      expect(m.palette.shell.id).toBe(id);
      expect(m.spacing(2)).toBe(`${8 * z / 100}px`);
    }
  });
});

describe('choosing', () => {
  it('follows the computer unless a theme is chosen', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme(undefined, true)).toBe('dark');
    expect(resolveTheme('halloween', false)).toBe('halloween');
    expect(resolveTheme('nonsense' as any, false)).toBe('light');
  });
  it('text size is clamped to 70–200 % in 10 % steps', () => {
    expect(clampZoom(40)).toBe(70);
    expect(clampZoom(300)).toBe(200);
    expect(clampZoom(114)).toBe(110);
    expect(clampZoom(NaN)).toBe(100);
  });
});

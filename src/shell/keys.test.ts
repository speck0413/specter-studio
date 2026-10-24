import { describe, expect, it } from 'vitest';
import { matches } from './keys';

const ev = (key: string, m: Partial<KeyboardEvent> = {}) => ({ key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m }) as KeyboardEvent;

describe('shortcuts', () => {
  it('matches Ctrl with the right modifiers only', () => {
    expect(matches(ev('P', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+P')).toBe(true);
    expect(matches(ev('p', { ctrlKey: true }), 'Mod+Shift+P')).toBe(false);
    expect(matches(ev('p', { ctrlKey: true }), 'Mod+P')).toBe(true);
    expect(matches(ev('ArrowLeft', { altKey: true }), 'Alt+ArrowLeft')).toBe(true);
    expect(matches(ev('ArrowLeft', { altKey: true, ctrlKey: true }), 'Alt+ArrowLeft')).toBe(false);
    expect(matches(ev('F1'), 'F1')).toBe(true);
    expect(matches(ev('+', { ctrlKey: true, shiftKey: true }), 'Mod+Shift++')).toBe(true);
    expect(matches(ev('=', { ctrlKey: true }), 'Mod+=')).toBe(true);
    expect(matches(ev('-', { ctrlKey: true }), 'Mod+-')).toBe(true);
  });
});

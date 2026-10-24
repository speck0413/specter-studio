import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentSave, handleSaveKey, registerSave, runSave } from './save';

const ev = (key: string, m: Partial<KeyboardEvent> = {}) => {
  const e = { key, code: '', ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...m };
  return e as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
};

describe('Save with the keyboard', () => {
  const removers: (() => void)[] = [];
  afterEach(() => { removers.splice(0).forEach((r) => r()); });

  it('runs what the page on screen registered; the last one wins until it goes away', () => {
    const a = vi.fn(); const b = vi.fn();
    removers.push(registerSave(() => ({ label: 'Save “a”', run: a })));
    const rb = registerSave(() => ({ label: 'Save “b”', run: b }));
    expect(currentSave()?.label).toBe('Save “b”');
    expect(runSave()).toBe(true);
    expect(b).toHaveBeenCalledTimes(1);
    rb();
    rb(); // removing twice changes nothing
    expect(runSave()).toBe(true);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+S is always taken (never the window\'s Save page), also with nothing to save', () => {
    const e = ev('s', { ctrlKey: true });
    expect(handleSaveKey(e)).toBe(true);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(currentSave()).toBeNull();
  });

  it('runs once per press (a held key does not save again and again) and leaves other keys alone', () => {
    const run = vi.fn();
    removers.push(registerSave(() => ({ label: 'Save', run })));
    handleSaveKey(ev('S', { ctrlKey: true }));
    handleSaveKey(ev('s', { ctrlKey: true, repeat: true }));
    expect(run).toHaveBeenCalledTimes(1);
    const other = ev('s');
    expect(handleSaveKey(other)).toBe(false);
    expect(handleSaveKey(ev('s', { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it('on a Mac it is ⌘S, not Ctrl+S', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' });
    try {
      const keys = await import('./keys');
      const mac = await import('./save');
      expect(keys.isMac).toBe(true);
      expect(keys.keyLabel(mac.SAVE_KEYS)).toBe('⌘S');
      const run = vi.fn();
      const off = mac.registerSave(() => ({ label: 'Save', run }));
      expect(mac.handleSaveKey(ev('s', { metaKey: true }))).toBe(true);
      expect(mac.handleSaveKey(ev('s', { ctrlKey: true }))).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      off();
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });

  it('elsewhere it is Ctrl+S, and the Windows key does not count', async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' });
    try {
      const keys = await import('./keys');
      const win = await import('./save');
      expect(keys.keyLabel(win.SAVE_KEYS)).toBe('Ctrl+S');
      expect(win.handleSaveKey(ev('s', { metaKey: true }))).toBe(false);
      expect(win.handleSaveKey(ev('s', { ctrlKey: true }))).toBe(true);
    } finally { vi.unstubAllGlobals(); vi.resetModules(); }
  });
});

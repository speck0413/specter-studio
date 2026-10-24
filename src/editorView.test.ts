import { describe, expect, it } from 'vitest';
import { editorView, showsBlocks, showsScript } from './editorView';

describe('the editor view preference', () => {
  it('defaults to script and blocks for new people and anything unknown', () => {
    expect(editorView(undefined)).toBe('both');
    expect(editorView('sideways')).toBe('both');
    expect(editorView('script')).toBe('script');
    expect(editorView('blocks')).toBe('blocks');
  });
  it('says which views are drawn', () => {
    expect([showsScript('both'), showsBlocks('both')]).toEqual([true, true]);
    expect([showsScript('script'), showsBlocks('script')]).toEqual([true, false]);
    expect([showsScript('blocks'), showsBlocks('blocks')]).toEqual([false, true]);
  });
});

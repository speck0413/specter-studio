import { describe, expect, it } from 'vitest';
import { filterCommands, Command } from './CommandPalette';

const c = (label: string, group = 'Action', also = ''): Command => ({ id: label, label, group, also, run: () => {} });
const list = [c('Theme: follow the computer (Light or Dark)', 'Theme'), c('Theme: Light', 'Theme'), c('Go to Your library', 'Go to'), c('Open board: Porch', 'Board', 'connected')];

describe('command palette filter', () => {
  it('keeps commands with every word, in any order and case', () => {
    expect(filterCommands(list, 'LIBRARY go').map((x) => x.label)).toEqual(['Go to Your library']);
    expect(filterCommands(list, 'board connected').map((x) => x.label)).toEqual(['Open board: Porch']);
    expect(filterCommands(list, '')).toHaveLength(4);
  });
  it('puts the name as typed first', () => {
    expect(filterCommands(list, 'theme light')[0].label).toBe('Theme: Light');
  });
});

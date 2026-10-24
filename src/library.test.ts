import { describe, expect, it } from 'vitest';
import { freeName, renameEffectLine, scriptBody, scriptHeader } from './library';

describe('a new effect never replaces one in the library', () => {
  it('keeps a free name and numbers a taken one', () => {
    expect(freeName(['graveyard'], 'porch scare')).toBe('porch scare');
    expect(freeName(['porch scare'], 'porch scare')).toBe('porch scare 2');
    expect(freeName(['Porch Scare', 'porch scare 2'], ' porch scare ')).toBe('porch scare 3');
  });
  it('renames the effect line that carried the old name, and nothing else', () => {
    const t = 'effect porch scare:\n  wait for trig1\n  out1 = on\n  sleep 5\n  out1 = off\n';
    expect(renameEffectLine(t, 'porch scare', 'porch scare 2')).toBe(t.replace('effect porch scare:', 'effect porch scare 2:'));
    expect(renameEffectLine('effect light up ghost:\n', 'porch scare', 'porch scare 2')).toBe('effect light up ghost:\n');
  });
});

describe("a board's script and Studio's header line", () => {
  it('splits off the header (name and save time) and keeps the rest as written', () => {
    const t = '# Specter Studio: porch, scare, saved 2026-10-23 10:40\neffect a:\n  wait for trig1\n';
    expect(scriptHeader(t)).toEqual({ name: 'porch, scare', saved: '2026-10-23 10:40' });
    expect(scriptBody(t)).toBe('effect a:\n  wait for trig1\n');
    expect(scriptBody('effect a:\n')).toBe('effect a:\n');
    expect(scriptHeader('# just a comment\n')).toBeNull();
  });
});

/// <reference types="node" />
// The tell line in the text editor (SHOW-SCRIPT.md §11): the boards Studio knows by their network names, their
// effects, the help, and no hint of Studio's own under the board's tell messages.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { completionsAt, lineStarts } from './completions';
import { fleetFrom, hostLabel, scriptEffects, tellName } from './fleet';
import { hoverFor } from './language';
import { defaultTerms } from './terms';
import { checkHint } from '../words';

const boards: Record<string, any> = {
  a: { key: 'a', info: { name: 'Front Door', id: 'sim0000c0de' }, script: { text: 'effect doorbell:\n  wait for trig1\n  tell porch blackout\n' } },
  b: { key: 'b', info: { name: 'Porch', id: 'abcd1234' }, script: { text: '# lights\neffect blackout:\n  wait for trig1\nEffect Porch  Light:  # spaces\n  wait for trig2\neffect a/b:\n  wait for user1\n' } },
  c: { key: 'c', info: { name: 'Crypt', id: 'ffff0001' } }, // its script is not known
  d: { key: 'adapter:x:1', adapter: 'x', info: { name: 'Smart plug' } }, // a device adapter's device: not a board
};
const fleet = fleetFrom(boards, 'a');
const labels = (before: string) => completionsAt(before, defaultTerms(), fleet).map((c) => c.label);

describe('the boards a tell line can name', () => {
  it('names a board as the firmware does (proto.cpp hostLabel)', () => {
    expect(hostLabel('Front Door')).toBe('front-door');
    expect(hostLabel('  Crypt #2 (left) ')).toBe('crypt-2-left');
    expect(hostLabel('Gruß Öffner')).toBe('gru-ffner');
    expect(hostLabel('x'.repeat(39) + ' yz')).toBe('x'.repeat(39));
    expect(hostLabel('***', 'sim0000c0de')).toBe('proptroller-c0de');
  });
  it('an effect as a tell line sends it: lower case, spaces as _, at most 32 characters, no / or +', () => {
    expect(tellName('Porch  Light')).toBe('porch_light');
    expect(tellName('a/b')).toBeNull();
    expect(tellName('x'.repeat(33))).toBeNull();
    expect(scriptEffects(boards.b.script.text)).toEqual(['blackout', 'porch_light']);
  });
  it('lists the other boards, never this one or a device adapter\'s device; effects only when the script is known', () => {
    expect(fleet).toEqual([
      { label: 'crypt', name: 'Crypt', effects: null },
      { label: 'porch', name: 'Porch', effects: ['blackout', 'porch_light'] },
    ]);
  });
});

describe('typeahead after tell', () => {
  it('offers tell at the start of a line', () => {
    expect(lineStarts().map((c) => c.label)).toContain('tell');
    expect(labels('  te')).toContain('tell');
  });
  it('after tell: the boards Studio knows, then all; each goes on to its effects', () => {
    expect(labels('  tell ')).toEqual(['crypt', 'porch', 'all']);
    expect(labels('  TELL po')).toEqual(['crypt', 'porch', 'all']);
    const porch = completionsAt('  tell ', defaultTerms(), fleet).find((c) => c.label === 'porch')!;
    expect(porch.insert).toBe('porch ');
    expect(porch.retrigger).toBe(true);
    expect(porch.detail).toContain('Porch');
    expect(labels('  tell ')).toEqual(['crypt', 'porch', 'all']);
    expect(completionsAt('  tell ', defaultTerms(), []).map((c) => c.label)).toEqual(['all']);
  });
  it('after a board: its effects when Studio knows its script, else none', () => {
    expect(labels('  tell porch ')).toEqual(['blackout', 'porch_light']);
    expect(labels('  tell Porch bl')).toEqual(['blackout', 'porch_light']);
    expect(labels('  tell crypt ')).toEqual([]);
    expect(labels('  tell nobody ')).toEqual([]);
    expect(labels('  tell all ')).toEqual(['blackout', 'porch_light']);
    // a setting is the person's to write
    expect(labels('  tell porch pixel_speed = ')).toEqual([]);
  });
});

describe('help for tell', () => {
  it('says it in plain words: network name, no wait, remote starts allowed, settings not saved', () => {
    const h = hoverFor('tell')!;
    expect(h).toContain('`tell porch blackout`');
    expect(h).toContain('front-door');
    expect(h).toMatch(/does not wait/);
    expect(h).toMatch(/remote_trigger_enable/);
    expect(h).toMatch(/remote_free_effects/);
    expect(h).toMatch(/not saved/);
    expect(h).toMatch(/restarts/);
  });
  it('adds no hint of its own under the board\'s tell messages (b02-tell-errors)', () => {
    const dir = path.resolve(__dirname, '../../firmware/firmware/show-script-golden/cases/b02-tell-errors');
    const c = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8'));
    const lines = fs.readFileSync(path.join(dir, 'script.txt'), 'utf8').split('\n');
    const tells = c.check.errors.filter((e: any) => /^\s*tell/i.test(lines[e.line - 1]));
    expect(tells.length).toBeGreaterThan(10);
    for (const e of tells) expect(checkHint(e.message, lines[e.line - 1])).toBeNull();
    expect(checkHint('line 3: "an effect with flicker in its name and far too long" cannot be sent as an effect\'s name: it has at most 32 characters, and no / or +.', '  tell porch an effect with flicker in its name and far too long')).toBeNull();
  });
});

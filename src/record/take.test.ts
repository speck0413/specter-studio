// A take (what was tapped and slid) → an effect script, through the firmware's shared take.js: rounding, joined
// holds, levels and fades, maximum on-times, sounds, limits, and putting a recording into a stored script.
import { describe, expect, it } from 'vitest';
import * as Blockly from 'blockly';
import { blocksToText, defineBlocks, textToBlocks } from '../effects/blocks';
import { dimmable, mergeScript, mergeTakes, plan, seconds, suggestName, takeToScript, Take } from './take';

const opts = { name: 'siren and lamp', trigger: 'trig1' };
const bodyOf = (text: string) => text.split('\n').filter((l) => l && !l.startsWith('#'));

describe('record effect: take → effect script', () => {
  it('writes seconds the way people do', () => {
    expect(seconds(2000)).toBe('2');
    expect(seconds(500)).toBe('0.5');
    expect(seconds(12340)).toBe('12.3');
  });

  it('rounds to 0.1 s on absolute times, cuts the quiet start and writes the waits between', () => {
    const take: Take = { holds: [{ target: 'rly1', start: 1234, end: 3480 }, { target: 'out1', start: 2010, end: 2560 }], sounds: [] };
    const r = takeToScript(take, opts);
    expect(r.error).toBeUndefined();
    expect(bodyOf(r.text)).toEqual([
      'effect siren and lamp:',
      '  wait for trig1',
      '  rly1 = on',      // 1.2 s → 0
      '  wait 0.8',
      '  out1 = on',      // 2.0 s
      '  wait 0.6',
      '  out1 = off',     // 2.6 s (2.56 rounds up)
      '  wait 0.9',
      '  rly1 = off',     // 3.5 s
    ]);
    expect(r.lengthMs).toBe(2300);
    // no drift: the waits add up to the rounded end
    const sum = bodyOf(r.text).filter((l) => /^  wait [0-9.]/.test(l)).reduce((a, l) => a + Number(l.split(' ').pop()), 0);
    expect(Math.round(sum * 10) / 10).toBe(2.3);
  });

  it('keeps the quiet start when asked, and never writes wait 0', () => {
    const r = takeToScript({ holds: [{ target: 'out2', start: 1500, end: 2000 }, { target: 'rly2', start: 1520, end: 2030 }], sounds: [] }, { ...opts, trimLead: false });
    expect(bodyOf(r.text).slice(2)).toEqual(['  wait 1.5', '  out2 = on', '  rly2 = on', '  wait 0.5', '  out2 = off', '  rly2 = off']);
    expect(r.text).not.toMatch(/wait 0\n/);
  });

  it('a very short tap still lasts one step', () => {
    const r = takeToScript({ holds: [{ target: 'cc1', start: 0, end: 20 }], sounds: [] }, opts);
    expect(bodyOf(r.text).slice(2)).toEqual(['  cc1 = on', '  wait 0.1', '  cc1 = off']);
  });

  it('joins holds of one output that overlap or touch (a second pass on top)', () => {
    const p = plan({ holds: [{ target: 'out1', start: 0, end: 1000 }, { target: 'out1', start: 800, end: 1500 }, { target: 'out1', start: 1520, end: 1800 }, { target: 'out1', start: 3000, end: 3200 }], sounds: [] });
    expect(p.segments.map((s) => [s.start, s.end])).toEqual([[0, 1800], [3000, 3200]]);
  });

  it('outputs that overlap each other run side by side, offs before ons at the same moment', () => {
    const r = takeToScript({ holds: [{ target: 'out1', start: 0, end: 1000 }, { target: 'out2', start: 1000, end: 2000 }], sounds: [] }, opts);
    expect(bodyOf(r.text).slice(2)).toEqual(['  out1 = on', '  wait 1', '  out1 = off', '  out2 = on', '  wait 1', '  out2 = off']);
  });

  it('cuts a hold at the maximum on-time and says so plainly', () => {
    const r = takeToScript({ holds: [{ target: 'rly1', start: 0, end: 7200 }, { target: 'out1', start: 0, end: 7200 }], sounds: [] },
      { ...opts, maxOnMs: { rly1: 5050, out1: 0 }, labels: { rly1: 'siren' } });
    expect(bodyOf(r.text).slice(2)).toEqual(['  out1 = on', '  rly1 = on', '  wait 5', '  rly1 = off', '  wait 2.2', '  out1 = off']);
    expect(r.notes).toEqual(['siren (RLY1) was held for 7.2 s, but this board turns it off after 5.1 s (its maximum on-time), so it stays on for 5 s.']);
    expect(r.segments.find((s) => s.target === 'rly1')!.cut).toBe(true);
  });

  it('a hold the recorder already let go at the limit keeps how long the finger stayed down', () => {
    const r = takeToScript({ holds: [{ target: 'rly1', start: 0, end: 3000, cut: true, heldMs: 4500 }], sounds: [] }, { ...opts, maxOnMs: { rly1: 3000 } });
    expect(bodyOf(r.text).slice(2)).toEqual(['  rly1 = on', '  wait 3', '  rly1 = off']);
    expect(r.notes[0]).toBe('RLY1 was held for 4.5 s, but this board turns it off after 3 s (its maximum on-time), so it stays on for 3 s.');
  });

  it('sound taps play by number', () => {
    const r = takeToScript({ holds: [{ target: 'out1', start: 500, end: 1500 }], sounds: [{ sound: 1, at: 520 }, { sound: 3, at: 1000 }] }, opts);
    expect(bodyOf(r.text).slice(2)).toEqual(['  out1 = on', '  audio_single = 1', '  wait 0.5', '  audio_single = 3', '  wait 0.5', '  out1 = off']);
    // a take of only sounds is fine too
    expect(bodyOf(takeToScript({ holds: [], sounds: [{ sound: 2, at: 300 }] }, opts).text).slice(2)).toEqual(['  audio_single = 2']);
  });

  it('splits a long take into one effect per output (they start together), within the board limits', () => {
    const holds = [];
    for (let i = 0; i < 14; i++) holds.push({ target: 'out1', start: i * 1000, end: i * 1000 + 400 }, { target: 'rly1', start: i * 1000 + 500, end: i * 1000 + 800 });
    const r = takeToScript({ holds, sounds: [{ sound: 1, at: 0 }] }, { ...opts, labels: { rly1: 'siren' } });
    expect(r.error).toBeUndefined();
    expect(r.effects).toBe(3);
    const headers = r.text.split('\n').filter((l) => l.startsWith('effect'));
    expect(headers).toEqual(['effect siren and lamp - out1:', 'effect siren and lamp - siren:', 'effect siren and lamp - sound:']);
    for (const e of r.text.split(/\n(?=effect )/).slice(1)) {
      expect(e.split('\n')[1]).toBe('  wait for trig1');
      expect(e.split('\n').filter((l) => l.trim()).length).toBeLessThanOrEqual(64);
    }
    // each output belongs to one effect
    expect(r.text.match(/rly1 = on/g)!.length).toBe(14);
  });

  it('refuses a take that cannot fit, with a plain reason', () => {
    const holds = [];
    for (let i = 0; i < 40; i++) holds.push({ target: 'out3', start: i * 500, end: i * 500 + 200 });
    const r = takeToScript({ holds, sounds: [] }, opts);
    expect(r.text).toBe('');
    expect(r.error).toMatch(/too much for one board: 40 taps on OUT3/);
    expect(takeToScript({ holds: [], sounds: [] }, opts).error).toMatch(/Nothing was tapped/);
  });

  it('names: a colon or a long name cannot break the header; a suggestion from what was tapped', () => {
    const r = takeToScript({ holds: [{ target: 'out1', start: 0, end: 100 }], sounds: [] }, { ...opts, name: 'scare: the  big one at the front door of the house' });
    expect(r.text).toContain('effect scare the big one at the front d:');
    expect(suggestName({ holds: [{ target: 'rly1', start: 0, end: 1 }, { target: 'out1', start: 0, end: 1 }], sounds: [] }, { rly1: 'siren' })).toBe('siren and OUT1');
    expect(suggestName({ holds: [], sounds: [{ sound: 1, at: 0 }] })).toBe('sound');
  });

  it('the result opens as blocks and comes back as the same text', () => {
    defineBlocks();
    const r = takeToScript({ holds: [{ target: 'rly1', start: 100, end: 2100 }, { target: 'out1', start: 600, end: 900 }], sounds: [{ sound: 1, at: 100 }] }, opts);
    const ws = new Blockly.Workspace();
    textToBlocks(ws, r.text);
    expect(blocksToText(ws)).toBe(r.text);
  });

  it('a slider on a dimmable output writes levels and a fade, and plays back along the same timeline', () => {
    expect(dimmable('out1')).toBe(true);
    expect(dimmable('rly1')).toBe(false);
    const levels = [{ target: 'out1', at: 0, level: 30 }, { target: 'out1', at: 1600, level: 40 }];
    for (let k = 1; k <= 7; k++) levels.push({ target: 'out1', at: 1600 + k * 100, level: 40 + k * 9 });
    const r = takeToScript({ holds: [], sounds: [], levels, end: 4000 }, opts);
    expect(r.error).toBeUndefined();
    const body = bodyOf(r.text).slice(2);
    expect(body[0]).toBe('  out1 = 30%');
    expect(body.some((l) => /^ {2}fade out1 to \d+% over /.test(l))).toBe(true);
    expect(body[body.length - 1]).toBe('  out1 = off');
    expect(r.timeline.length).toBeGreaterThan(3);
    expect(r.timeline[r.timeline.length - 1]).toMatchObject({ target: 'out1', level: 0 });
  });

  it('add more on top: two passes become one take', () => {
    const t = mergeTakes({ holds: [{ target: 'out1', start: 0, end: 500 }], sounds: [] }, { holds: [{ target: 'rly1', start: 200, end: 400 }], sounds: [{ sound: 1, at: 100 }] });
    expect(t.holds).toHaveLength(2);
    expect(t.sounds).toHaveLength(1);
  });

  it('a recording goes into the stored script without touching the other effects, and clashes are named', () => {
    const stored = 'effect door:\n  wait for trig2\n  rly1 = on\n  sleep 1\n  rly1 = off\n';
    const rec = takeToScript({ holds: [{ target: 'out1', start: 0, end: 500 }], sounds: [] }, { ...opts, name: 'lamp' }).text;
    const m = mergeScript(stored, rec, 'lamp');
    expect(m.text.startsWith(stored.trimEnd())).toBe(true);
    expect(m.text).toContain('effect lamp:');
    expect(m.clashes).toEqual([]);
    const clash = mergeScript(stored, takeToScript({ holds: [{ target: 'rly1', start: 0, end: 500 }], sounds: [] }, { ...opts, name: 'other' }).text, 'other');
    expect(clash.clashes).toEqual([{ output: 'rly1', effect: 'door' }]);
  });
});

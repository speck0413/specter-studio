import { describe, expect, it } from 'vitest';
import { applyEdit, editOf, heldKept, inputTriggers, linkName, linkShow, lowestFreeId, scriptTargets, showTargets, wantsHeld } from './shows';
import { conflicts, overlaps } from '../words';

const door = { id: 3, name: 'Door', enabled: true, triggers: [{ on: 'input', input: 'TRIG1' }, { on: 'every', period_ms: 5000 }], cooldown_ms: 3000, retrigger: 'ignore',
  tracks: [{ target: 'OUT1', cues: [{ at: 0, do: 'pulse', ms: 2000 }] }, { target: 'PIXEL', cues: [{ at: 0, do: 'flash', color: '#ffffff' }] }] };

describe('shows', () => {
  it('never assumes show 1 exists: the lowest free id', () => {
    expect(lowestFreeId([])).toBe(1);
    expect(lowestFreeId([1, 2, 4])).toBe(3);
    expect(lowestFreeId([2, 3])).toBe(1);
  });
  it('links: on while held (until_release) or a pulse of N seconds', () => {
    expect(linkName('trig1', ['out1', 'rly2'])).toBe('Link: TRIG1 -> OUT1, RLY2');
    expect(linkShow({ id: 5, input: 'TRIG1', outputs: ['OUT1'], mode: 'held', seconds: 60 })).toEqual({
      id: 5, name: 'Link: TRIG1 -> OUT1', enabled: true, triggers: [{ on: 'input', input: 'TRIG1', until_release: true }],
      tracks: [{ target: 'OUT1', cues: [{ at: 0, do: 'on' }] }], length_ms: 60000 });
    const p = linkShow({ id: 2, input: 'TRIG2', outputs: ['OUT1', 'OUT2'], mode: 'pulse', seconds: 1.5 }, false);
    expect(p.enabled).toBe(false);
    expect(p.triggers).toEqual([{ on: 'input', input: 'TRIG2' }]);
    expect(p.tracks[1]).toEqual({ target: 'OUT2', cues: [{ at: 0, do: 'pulse', ms: 1500 }] });
  });
  it('the editor sends back the board data with only its fields changed, and drops until_release when off', () => {
    expect(inputTriggers(door)).toEqual([0]);
    const e = editOf(door);
    expect(e).toEqual({ name: 'Door', enabled: true, held: { 0: false } });
    const on = applyEdit(door, { ...e, held: { 0: true } });
    expect(on.triggers[0]).toEqual({ on: 'input', input: 'TRIG1', until_release: true });
    expect(on.triggers[1]).toEqual(door.triggers[1]);
    expect(on.cooldown_ms).toBe(3000);
    expect(on.tracks).toEqual(door.tracks);
    expect(door.triggers[0]).not.toHaveProperty('until_release'); // the original is untouched
    const off = applyEdit(on, { name: 'Front door', enabled: false, held: { 0: false } });
    expect(off.triggers[0]).toEqual({ on: 'input', input: 'TRIG1' });
    expect(off).toMatchObject({ name: 'Front door', enabled: false });
    expect(wantsHeld(on)).toBe(true);
    expect(wantsHeld(off)).toBe(false);
  });
  it('tells a firmware that dropped until_release', () => {
    const sent = linkShow({ id: 5, input: 'TRIG1', outputs: ['OUT1'], mode: 'held', seconds: 10 });
    expect(heldKept(sent, sent)).toBe(true);
    expect(heldKept(sent, { ...sent, triggers: [{ on: 'input', input: 'TRIG1' }] })).toBe(false);
    expect(heldKept(door, door)).toBe(true);
  });
  it('targets of a show and of an effect script', () => {
    expect(showTargets(door)).toEqual(['OUT1', 'PIXEL']);
    expect(scriptTargets('effect a:\n  wait for trig1\n  audio_single = 1\n  out2 = on # not out3\n  fade out1 to 0% over 2\n').sort()).toEqual(['OUT1', 'OUT2', 'SOUND']);
  });
});

describe('a show and the effect script on one input', () => {
  const kit = 'effect big moment:\n  wait for trig1\n  audio_single = 1\n  out2 = on\n  out1 = on\n';
  it('the starter kit (the show does the pixels, the script the rest) is explained, not warned about', () => {
    const b: any = { script: { text: kit }, shows: [{ id: 2, name: 'Big moment pixels', enabled: true, inputs: ['TRIG1'], targets: ['PIXEL'] }] };
    expect(conflicts(b)).toEqual([]);
    const [o] = overlaps(b);
    expect(o).toMatchObject({ input: 'TRIG1', intended: true, show: { id: 2, name: 'Big moment pixels' } });
    expect(o.text).toContain('That looks intended');
  });
  it('a show driving what the script drives is still a warning, and a show that is off never counts', () => {
    const b: any = { script: { text: kit }, shows: [{ id: 1, name: 'Door', enabled: true, inputs: ['TRIG1'], targets: ['OUT1', 'PIXEL'] }, { id: 4, name: 'Off', enabled: false, inputs: ['TRIG1'], targets: ['PIXEL'] }] };
    expect(conflicts(b)).toEqual(['TRIG1 starts both the show “Door” and the effect script: one press runs both. Both drive OUT1.']);
    expect(overlaps(b)).toHaveLength(1);
  });
  it('a commented-out wait does not count', () => {
    const b: any = { script: { text: 'effect a:\n  # wait for trig1\n  wait for trig2\n' }, shows: [{ id: 1, name: 'Door', enabled: true, inputs: ['TRIG1'], targets: ['OUT1'] }] };
    expect(overlaps(b)).toEqual([]);
  });
});

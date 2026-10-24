import { describe, expect, it } from 'vitest';
import { completionsAt, nameHover, PAUSE } from './completions';
import { defaultTerms, soundList, termsFor } from './terms';

const board = termsFor(
  {
    inputs: ['TRIG1', 'TRIG2', 'USER1', 'USER2', 'USER3'],
    channels: ['OUT1', 'OUT2', 'OUT3', 'OUT4', 'RLY1', 'RLY2', 'CC1', 'CC2'],
    terminals: [
      { id: 'TRIG1', kind: 'input', label: 'bell' },
      { id: 'OUT1', kind: 'output', label: 'Lamp' },
      { id: 'RLY1', kind: 'output', label: '', alias: 'FOG' },
    ],
  },
  { aliases: [{ alias: 'valve_time', key: 'out1_on_ms' }, { alias: 'go', control: 'trigger' }] },
  soundList({ '0001-chime.mp3': 1, '0002-scream.mp3': 2 }),
);
const labels = (before: string, t = defaultTerms()) => completionsAt(before, t).map((c) => c.label);

describe('typeahead: levels', () => {
  it('a dimmable output: on, off and one "level %" with its number selected', () => {
    const c = completionsAt('  out1 = ', defaultTerms());
    expect(c.map((x) => x.label)).toEqual(['on', 'off', 'level %']);
    const lvl = c.find((x) => x.label === 'level %')!;
    expect(lvl.insert).toBe('${1:50}%');
    expect(lvl.snippet).toBe(true);
    // not three percentages
    expect(c.filter((x) => /\d+%/.test(x.label))).toEqual([]);
  });
  it('a relay or contact: on and off only', () => {
    expect(labels('  rly1 = ')).toEqual(['on', 'off']);
    expect(labels('  cc2 =')).toEqual(['on', 'off']);
    expect(labels('  RLY1 = 5')).toEqual([]);
  });
  it('a typed number gets its % sign on an output that dims', () => {
    expect(completionsAt('  out2 = 40', defaultTerms())).toMatchObject([{ label: '40%', insert: '40%' }]);
    expect(labels('  fade out1 to 7')).toEqual(['7%']);
  });
  it('names given on the board: lamp dims, fog (a relay) does not', () => {
    expect(labels('  lamp = ', board)).toEqual(['on', 'off', 'level %']);
    expect(labels('  fog = ', board)).toEqual(['on', 'off']);
    expect(labels('  dmx12 = ', board)).toContain('level %');
  });
});

describe('typeahead: inputs, outputs, sounds and times', () => {
  it('wait for: the inputs by their names, and a time', () => {
    const c = completionsAt('  wait for ', board);
    expect(c[0]).toMatchObject({ label: 'bell (trig1)', insert: 'trig1' });
    expect(c.map((x) => x.label)).toEqual(expect.arrayContaining(['trig2', 'user3', 'seconds', 'ms', 'min', 'cooldown_ms']));
  });
  it(`${PAUSE}: "for" and an input, or a time, units and the time settings`, () => {
    const c = completionsAt(`  ${PAUSE} `, board);
    expect(c.find((x) => x.label === 'for bell (trig1)')!.insert).toBe('for trig1');
    expect(c.map((x) => x.label)).toEqual(expect.arrayContaining(['seconds', 'ms', 'min', 'out1_on_ms', 'valve_time (out1_on_ms)']));
    expect(c.map((x) => x.label)).not.toContain('go (trigger)');
    expect(labels(`  ${PAUSE} 2 `)).toEqual(['s', 'ms', 'min']);
  });
  it('sleep, over, for and per: units and the time settings', () => {
    for (const b of ['  sleep ', '  fade out1 to 0% over ', '  flicker out1 for ', '  pulse cc1 for ', '  limit 3 runs per ']) {
      expect(labels(b)).toEqual(expect.arrayContaining(['seconds', 'ms', 'min', 'recover_time_ms']));
      expect(labels(b)).not.toContain('trig1');
    }
    expect(labels('  pulse cc1 for 200 ')).toEqual(['s', 'ms', 'min']);
    expect(labels('  limit ')).toEqual(['runs', 'runs_per_cooldown']);
  });
  it('fade and flicker offer only outputs that dim; pulse all of them', () => {
    expect(labels('  fade ')).toEqual(['out1', 'out2', 'out3', 'out4']);
    expect(labels('  flicker ', board)).toEqual(['Lamp (out1)', 'out2', 'out3', 'out4']);
    expect(labels('  pulse ')).toEqual(['out1', 'out2', 'out3', 'out4', 'rly1', 'rly2', 'cc1', 'cc2']);
  });
  it('sounds after audio_single / audio_loop (off for the loop)', () => {
    // numbers, with the description as the hint
    expect(completionsAt('audio_single = ', board)).toMatchObject([{ label: '1', insert: '1', detail: 'chime' }, { label: '2', insert: '2', detail: 'scream' }]);
    expect(labels('  audio_loop =', board)).toEqual(['1', '2', 'off']);
    expect(labels('  audio_single = ')).toEqual(['sound number']);
  });
  it('the start of a line: line kinds and the outputs by their names', () => {
    const c = completionsAt('  ', board);
    expect(c.find((x) => x.label === 'Lamp (out1) =')).toMatchObject({ insert: 'out1 = ', retrigger: true });
    expect(c.find((x) => x.label === 'FOG (rly1) =')).toBeTruthy();
    expect(c.find((x) => x.label === PAUSE)!.insert).toBe(`${PAUSE} \${1:2}`);
  });
  it('nothing inside a comment', () => expect(labels('  out1 = on # out1 = ')).toEqual([]));
  it('hover help for a name given on the board', () => {
    expect(nameHover('lamp', board)).toMatch(/given to out1/);
    expect(nameHover('valve_time', board)).toMatch(/out1_on_ms/);
    expect(nameHover('banana', board)).toBeNull();
  });
});

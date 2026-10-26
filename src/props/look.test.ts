/// <reference types="node" />
// Icon and colour comments, the picker's writer, the run-length estimate and the fallbacks.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { effectName, lookOf, parseLook, runLengthMs, setLook, settingNames, settingsOf, timeMs } from './look';
import { colorHex, extIconsFrom, inkOn, resolveIcon } from './icons';

const TABLE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../tests/fixtures/look-cases.json'), 'utf8'));
const CASES: [string, any][] = TABLE.cases.map((c: any) => [c.name, c]);
const clean = (l: any) => Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));

describe('look comments (the table core/src/library.rs reads too)', () => {
  it.each(CASES)('%s', (_n, c) => {
    expect(clean(lookOf(c.text))).toEqual(c.list);
    const p = parseLook(c.text);
    expect(p.effects.map((e) => e.key).sort()).toEqual(Object.keys(c.effects).sort());
    for (const [name, want] of Object.entries(c.effects)) expect(clean(lookOf(c.text, name))).toEqual(want);
  });

  it('effect names as the checker reads them', () => {
    expect(effectName('effect porch light:   # front')).toBe('porch light');
    expect(effectName('Effect1:')).toBe('Effect1');
    expect(effectName('effect: ')).toBe('');
    expect(effectName('  out1 = on')).toBeNull();
    expect(effectName('# effect a:')).toBeNull();
  });

  it('matches the board\'s effect names whatever their case, spacing or underscores', () => {
    const t = '# icon: ghost\n\n# icon: bat\neffect Porch  Light:\n  wait for trig1\n';
    expect(lookOf(t, 'porch_light').icon).toBe('bat');
    expect(lookOf(t, 'PORCH LIGHT').icon).toBe('bat');
    expect(lookOf(t, 'not there').icon).toBe('ghost');
  });
});

describe('the picker writes only its own lines', () => {
  const twoStep = '# The prop.\neffect fire:\n  wait for trig1\n  sleep 1\n\neffect prime:  # the pump\n  wait for trig2\n';
  it('an effect\'s icon goes directly above its line, and changes in place', () => {
    let t = setLook(twoStep, 'prime', 'icon', 'drop');
    expect(t).toBe('# The prop.\neffect fire:\n  wait for trig1\n  sleep 1\n\n# icon: drop\neffect prime:  # the pump\n  wait for trig2\n');
    t = setLook(t, 'prime', 'icon', 'splat');
    expect(t).toContain('# icon: splat\neffect prime:');
    expect(t).not.toContain('drop');
    expect(setLook(t, 'prime', 'icon', null)).toBe(twoStep);
  });

  it('the script\'s look stays apart from a first effect that has comments on top', () => {
    const t = setLook(twoStep, null, 'icon', 'skull');
    expect(t).toBe(`# icon: skull\n\n${twoStep}`);
    expect(lookOf(t).icon).toBe('skull');
    expect(parseLook(t).effects[0].look.icon).toBeUndefined();
    // and a first effect's own does not become the script's
    const u = setLook(twoStep, 'fire', 'icon', 'fire');
    expect(parseLook(u).script.icon).toBeUndefined();
    expect(lookOf(u, 'prime').icon).toBeUndefined();
  });

  it('keeps line endings, other comments and a missing final newline', () => {
    const t = 'effect a:\r\n  wait for trig1\r\n  sleep 1';
    expect(setLook(t, 'a', 'color', '#c00')).toBe('# color: #c00\r\neffect a:\r\n  wait for trig1\r\n  sleep 1');
    expect(setLook(t, null, 'icon', 'eye')).toBe('# icon: eye\r\n\r\neffect a:\r\n  wait for trig1\r\n  sleep 1');
    expect(setLook('', null, 'icon', 'bell')).toBe('# icon: bell\n');
    const x = '# icon: star\n# a note\n\neffect a:\n  wait for trig1\n';
    expect(setLook(x, null, 'icon', 'bell')).toBe('# icon: bell\n# a note\n\neffect a:\n  wait for trig1\n');
    expect(setLook(x, 'nope', 'icon', 'bell')).toBe(x);
  });
});

describe('how long a run takes', () => {
  const s = 'effect scare:\n  audio_loop = 1\n  wait for trig1\n  limit 3 runs per 3 min\n  pulse cc1 for 200 ms\n  out1 = on\n  sleep 2.5\n  fade out1 to 0% over 500 ms\n  flicker out2 for 1 min\n  out2 = off\n\neffect b:\n  wait for trig2\n  sleep out1_on_ms\n  pulse rly1 for 10\n';
  it('sums sleeps, fades and flickers after the first wait for', () => expect(runLengthMs(s, 'scare')).toBe(2500 + 500 + 60000));
  it('the lines above the first wait for run again at the end of a run', () =>
    expect(runLengthMs('effect a:\n  out1 = 20%\n  sleep 1\n  wait for trig1\n  out1 = on\n  sleep 2\n', 'a')).toBe(3000));
  it('a pulse that outlasts the lines counts; settings come from the board', () => {
    expect(runLengthMs(s, 'b', { out1_on_ms: 3000 })).toBe(13000);
    expect(runLengthMs(s, 'b', { out1_on_ms: 12000 })).toBe(12000 + 10000);
  });
  it('unknown: a setting the board did not give, a second wait for, no such effect', () => {
    expect(runLengthMs(s, 'b')).toBeNull();
    expect(runLengthMs('effect a:\n  wait for trig1\n  sleep 1\n  wait for trig2\n  sleep 1\n', 'a')).toBeNull();
    expect(runLengthMs(s, 'nope')).toBeNull();
    expect(runLengthMs('effect candle:\n  out1 = 40%\n  flicker out1 for 3\n', 'candle')).toBeNull(); // no wait for: never started
    expect(runLengthMs(undefined, 'a')).toBeNull();
  });
  it('times and units', () => {
    expect(timeMs('2')).toBe(2000);
    expect(timeMs('200 ms')).toBe(200);
    expect(timeMs('1.5min')).toBe(90000);
    expect(timeMs('3 seconds')).toBe(3000);
    expect(timeMs('3 parsecs')).toBeNull();
    expect(timeMs('AIR_ON_TIME', { air_on_time: 1000 })).toBe(1000);
  });
  it('settings named by a profile, read from the board', () => {
    const prop = '# icon: splat\neffect drop:\n  audio_loop = 1\n  wait for button\n  limit runs_allowed runs per rest_time\n  audio_single = 2\n  pulse cc1 for role_pulse_ms\n  lid = on\n  sleep lid_time\n  lid = off\n  sleep 10 ms\n  fan = on\n  sleep fan_time\n  fan = off\n';
    expect(settingNames(prop).sort()).toEqual(['fan_time', 'lid_time', 'role_pulse_ms']);
    const st = settingsOf([{ key: 'lid_time', value: 1000 }, { key: 'FAN_TIME', value: '5500' }, { key: 'role_pulse_ms', value: 200 }, { key: 'name', value: 'Prop 1' }]);
    expect(runLengthMs(prop, 'drop', st)).toBe(6510);
  });
});

describe('icons and colours', () => {
  it('unknown or missing names are play; colours fall back to the icon\'s own', () => {
    expect(resolveIcon('unicorn').name).toBe('play');
    expect(resolveIcon(undefined).known).toBe(false);
    expect(resolveIcon('SPLAT').color).toBe('#d32f2f');
    expect(resolveIcon('blood').name).toBe('splat');
    expect(resolveIcon('skull', '#0a0').color).toBe('#00aa00');
    expect(resolveIcon('skull', 'nonsense').color).toBe('#f5f5f5');
  });
  it('every built-in the brief asks for is there', () => {
    for (const n of ['splat', 'lightning', 'fog', 'bulb', 'sound', 'skull', 'ghost', 'bat', 'spider', 'door', 'eye', 'fire', 'star', 'bell', 'play', 'drop']) expect(resolveIcon(n).name).toBe(n);
  });
  it('colour names and codes', () => {
    expect(colorHex('Gray')).toBe('#757575');
    expect(colorHex('#ABC')).toBe('#aabbcc');
    expect(colorHex('#12345')).toBeNull();
    expect(inkOn('#f5f5f5')).toBe('#000000');
    expect(inkOn('#7b1fa2')).toBe('#ffffff');
  });
  it('extension icons never replace a built-in, and are sanitized', () => {
    const ok = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6"/></svg>';
    const e = extIconsFrom([
      { id: 'a', name: 'A', icon: ok, icons: [{ name: 'lantern', svg: ok }, { name: 'skull', svg: ok }, { name: 'Bad Name', svg: ok }, { name: 'evil', svg: '<script>x</script>' }] },
      { id: 'b', icons: [{ name: 'lantern', svg: '<svg><rect width="2" height="2"/></svg>' }] },
    ]);
    expect(Object.keys(e.icons)).toEqual(['lantern']);
    expect(e.icons.lantern.from).toBe('A');
    expect(e.logos.a).toContain('<circle');
    expect(resolveIcon('lantern', undefined, e).svg).toContain('<circle');
    expect(resolveIcon('skull', undefined, e).builtin).toBeTruthy();
  });
});

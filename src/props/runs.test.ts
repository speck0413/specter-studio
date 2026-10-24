// The run tracker: a run event starts a run and a flash; states end it, give a show's length, and start (without
// a flash) a run Studio did not hear begin.
import { describe, expect, it } from 'vitest';
import { RunTracker, runningIn, START_GRACE_MS, RUN_CAP_MS } from './runs';

const st = (effects: [string, boolean][], extra: any = {}) => ({ script: { effects: effects.map(([name, running]) => ({ name, running, line: 3 })) }, ...extra });

describe('run tracker', () => {
  it('a run event starts a run and a flash; the state ends it after the grace', () => {
    const t = new RunTracker();
    t.runEvent('door', { source: 'input', kind: 'script', name: 'Scare' }, 1000);
    expect(t.runs.door).toMatchObject({ kind: 'script', name: 'Scare', started: 1000 });
    expect(t.flashes.door).toMatchObject({ name: 'Scare', at: 1000 });
    // an older state that does not show it yet does not end it
    t.noteState('door', st([['scare', false]]), 1100);
    expect(t.runs.door).toBeTruthy();
    t.noteState('door', st([['scare', true]]), 2000);
    expect(t.runs.door?.started).toBe(1000);
    t.noteState('door', st([['scare', false]]), 1000 + START_GRACE_MS + 1);
    expect(t.runs.door).toBeUndefined();
    expect(t.flashes.door?.name).toBe('Scare'); // the flash itself times out in the card
  });

  it('a state with a running effect and no event starts a run without a flash', () => {
    const t = new RunTracker();
    t.noteState('a', st([['one', false], ['two', true]]), 500);
    expect(t.runs.a).toMatchObject({ kind: 'script', name: 'two', started: 500 });
    expect(t.flashes.a).toBeUndefined();
  });

  it('the latest run event wins (no backlog)', () => {
    const t = new RunTracker();
    t.runEvent('a', { kind: 'script', name: 'one' }, 0);
    t.runEvent('a', { kind: 'script', name: 'two' }, 10);
    expect(t.runs.a?.name).toBe('two');
    expect(t.flashes.a).toMatchObject({ name: 'two', seq: 2 });
  });

  it('shows take their own length and elapsed time', () => {
    const t = new RunTracker();
    t.runEvent('a', { kind: 'show', show: 1, name: 'Door' }, 10_000);
    t.noteState('a', { shows: [{ id: 1, name: 'Door', state: 'running', elapsed_ms: 400, length_ms: 4000 }] }, 10_500);
    expect(t.runs.a).toMatchObject({ kind: 'show', lengthMs: 4000, started: 10_000 });
    t.noteState('a', { shows: [{ id: 1, name: 'Door', state: 'cooldown' }] }, 15_000);
    expect(t.runs.a).toBeUndefined();
  });

  it('a firmware that says nothing about scripts: the cap ends the run', () => {
    const t = new RunTracker();
    t.runEvent('a', { kind: 'script', name: 'x' }, 0);
    t.noteState('a', { outputs: [] }, 60_000);
    expect(t.runs.a).toBeTruthy();
    t.noteState('a', { outputs: [] }, RUN_CAP_MS + 1);
    expect(t.runs.a).toBeUndefined();
  });

  it('the built-in effect runs while pulsing or recovering', () => {
    expect(runningIn({ status: [{ key: 'pulsing', value: true }] })).toEqual([{ kind: 'effect', name: 'pulse_and_recover' }]);
    expect(runningIn({ status: [{ key: 'pulsing', value: false }] })).toEqual([]);
    // with a script, pulsing is the script's OUT1: its effects say what runs
    expect(runningIn({ status: [{ key: 'pulsing', value: true }], script: { effects: [{ name: 'a', running: false }] } })).toEqual([]);
  });

  it('forget lets go of a board that went away', () => {
    const t = new RunTracker();
    t.runEvent('a', { kind: 'effect', name: 'pulse_and_recover' }, 0);
    t.forget('a');
    expect(t.runs.a).toBeUndefined();
  });
});

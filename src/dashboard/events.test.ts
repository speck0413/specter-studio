import { describe, expect, it } from 'vitest';
import { ago, countsOf, fromBoardMsg, onlineEvent, runText, topicLabel, whenText } from './events';
import { Feed } from './feed';

const T = 1_700_000_000_000;
const runMsg = { v: 1, seq: 7, event: 'run', data: { source: 'input', kind: 'show', show: 1, name: 'Door', detail: 'TRIG1', runs_since_power_on: 3, runs_lifetime: 120, uptime_ms: 5000 } };

describe('feed events', () => {
  it('reads a run event with its source and counts', () => {
    const e = fromBoardMsg('Front Door', runMsg, T)!;
    expect(e).toMatchObject({ type: 'run', board: 'Front Door', source: 'input', kind: 'show', runs_tonight: 3, runs_lifetime: 120, via: 'direct' });
    expect(e.text).toBe('Show “Door” ran (TRIG1 pressed)');
    expect(runText({ kind: 'effect', source: 'api' })).toBe('The built-in effect ran (from Studio, the web page or MQTT)');
    expect(runText({ kind: 'script', name: 'porch light', source: 'input', detail: 'TRIG1' })).toBe('Effect “porch light” ran (TRIG1 pressed)');
  });

  it('a started notice is a run only for a firmware without run counters', () => {
    const n = { event: 'notice', data: { notice: 'started', show: 2, cause: { by: 'cue', detail: 'fog' } } };
    expect(fromBoardMsg('A', n, T)).toBeNull();
    expect(fromBoardMsg('A', n, T, true)).toMatchObject({ type: 'run', text: 'Show 2 ran (cue “fog”)' });
  });

  it('sorts other events into status, settings, errors and the rest', () => {
    expect(fromBoardMsg('A', { event: 'params_changed' }, T)?.type).toBe('settings');
    expect(fromBoardMsg('A', { event: 'notice', data: { notice: 'ended', show: 1, reason: 'finished' } }, T)?.type).toBe('status');
    expect(fromBoardMsg('A', { event: 'notice', data: { notice: 'watchdog', channel: 'OUT2' } }, T)?.type).toBe('error');
    expect(fromBoardMsg('A', { event: 'log', data: 'saving to flash failed: trying again in 2 s' }, T)?.type).toBe('error');
    expect(fromBoardMsg('A', { event: 'log', data: 'sound player online' }, T)?.type).toBe('log');
    expect(fromBoardMsg('A', { event: 'log', data: 'run #4 (TRIG1)' }, T)).toBeNull(); // the run event says it
    expect(fromBoardMsg('A', { event: 'update', data: { phase: 'failed', message: 'bad image' } }, T)?.type).toBe('error');
    expect(fromBoardMsg('A', { event: 'state', data: {} }, T)).toBeNull();
    expect(fromBoardMsg('A', null, T)).toBeNull();
    expect(onlineEvent('A', false, T, 'mqtt')).toMatchObject({ type: 'online', text: 'Offline', via: 'mqtt' });
  });

  it('reads the counters from a state or from MQTT status values', () => {
    expect(countsOf({ runs_since_power_on: 2, runs_lifetime: 40, last_run_uptime_ms: 900, uptime_ms: 5000 })).toEqual({ tonight: 2, lifetime: 40, lastRunUptime: 900, uptime: 5000 });
    expect(countsOf({ uptime_ms: 1 }, { runs_since_power_on: 0, runs_lifetime: 7, last_run_uptime_ms: -1 })).toEqual({ tonight: 0, lifetime: 7, lastRunUptime: undefined, uptime: 1 });
    expect(countsOf({ uptime_ms: 1 })).toBeNull(); // an older firmware
  });

  it('matches names to MQTT topic labels and says times in words', () => {
    expect(topicLabel('Front Door')).toBe('front-door');
    expect(topicLabel('  Crypt #2 ')).toBe('crypt-2');
    expect(ago(T - 5000, T)).toBe('just now');
    expect(ago(T - 125_000, T)).toBe('2 min ago');
    expect(ago(T - 3 * 3600_000, T)).toBe('3 h 0 min ago');
    expect(whenText(undefined, T)).toBe('not yet');
  });
});

describe('the feed', () => {
  it('keeps the last run per board and fills it in from a state', () => {
    const f = new Feed();
    f.add(fromBoardMsg('Front Door', runMsg, T)!, 'front-door', 5000);
    expect(f.lastRun['front-door']).toEqual({ at: T, uptime: 5000 });
    f.noteState('front-door', { uptime_ms: 5100, last_run_uptime_ms: 5000 }, T + 100); // the same run
    expect(f.lastRun['front-door'].at).toBe(T);
    f.noteState('crypt', { uptime_ms: 65_000, last_run_uptime_ms: 5000 }, T); // a run Studio did not hear
    expect(f.lastRun['crypt'].at).toBe(T - 60_000);
    f.noteState('crypt', { uptime_ms: 1000 }, T); // no run since power-on: nothing changes
    expect(f.lastRun['crypt'].at).toBe(T - 60_000);
  });

  it('queues events per night and writes each night once', async () => {
    const f = new Feed();
    const written: [string, number][] = [];
    f.writer = async (n, evs) => { written.push([n, evs.length]); };
    const t0 = new Date(2026, 9, 23, 19).getTime();
    f.add({ t: t0, board: 'A', type: 'run', text: 'ran' }, 'a');
    f.add({ t: t0 + 6 * 3600_000, board: 'A', type: 'run', text: 'ran' }, 'a'); // 1 am: same night
    f.add({ t: t0 + 24 * 3600_000, board: 'A', type: 'run', text: 'ran' }, 'a'); // next evening
    await f.flush();
    expect(written).toEqual([['2026-10-23', 2], ['2026-10-24', 1]]);
    await f.flush();
    expect(written).toHaveLength(2);
    f.clear();
    expect(f.events).toHaveLength(0);
  });
});

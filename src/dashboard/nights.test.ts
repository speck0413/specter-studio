import { describe, expect, it } from 'vitest';
import { eveningOf, groupNights, NIGHT_GAP_MS, placeEvent, type NightCursor } from './nights';
import type { FeedEvent } from './events';

// local time, as the person's computer sees it
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const run = (t: number, board = 'Front Door'): FeedEvent => ({ t, board, type: 'run', text: 'ran' });

describe('show nights', () => {
  it('names a night after its evening, also for a run after midnight', () => {
    expect(eveningOf(at(23, 19))).toBe('2026-10-23');
    expect(eveningOf(at(24, 1, 30))).toBe('2026-10-23');
    expect(eveningOf(at(24, 11, 59))).toBe('2026-10-23');
    expect(eveningOf(at(24, 12))).toBe('2026-10-24');
    expect(eveningOf(new Date(2026, 10, 1, 0, 30).getTime())).toBe('2026-10-31'); // across a month
  });

  it('7 pm to 2 am is one night', () => {
    const evs = [run(at(23, 19, 5)), run(at(23, 21, 40), 'Crypt'), run(at(23, 23, 59)), run(at(24, 0, 10)), run(at(24, 1, 58), 'Crypt')];
    const n = groupNights(evs);
    expect(n).toHaveLength(1);
    expect(n[0].night).toBe('2026-10-23');
    expect(n[0].runs).toBe(5);
    expect(n[0].boards).toEqual({ 'Front Door': 3, Crypt: 2 });
    expect(n[0].first).toBe(at(23, 19, 5));
    expect(n[0].last).toBe(at(24, 1, 58));
  });

  it('two shows on consecutive evenings are two nights', () => {
    const evs = [run(at(23, 19)), run(at(23, 22)), run(at(24, 1)), run(at(24, 2)), run(at(24, 19, 30)), run(at(24, 23)), run(at(25, 1, 45))];
    const n = groupNights(evs);
    expect(n.map((x) => x.night)).toEqual(['2026-10-23', '2026-10-24']);
    expect(n.map((x) => x.runs)).toEqual([4, 3]);
  });

  it('a quiet spell of exactly the gap starts a new night; less does not', () => {
    const t = at(23, 19);
    expect(groupNights([run(t), run(t + NIGHT_GAP_MS - 1)])).toHaveLength(1);
    expect(groupNights([run(t), run(t + NIGHT_GAP_MS)])).toHaveLength(2);
  });

  it('leaves events that are not runs out of the totals, in any order', () => {
    const evs: FeedEvent[] = [run(at(24, 1)), { t: at(23, 18), board: 'Crypt', type: 'online', text: 'Online' }, run(at(23, 22))];
    const n = groupNights(evs);
    expect(n).toHaveLength(1);
    expect(n[0].runs).toBe(2);
  });

  it('places live events: runs move the night on, other events join the running night', () => {
    let cur: NightCursor | null = null;
    let p = placeEvent(cur, at(23, 18, 30), false); // a board online before the first run
    expect(p.night).toBe('2026-10-23');
    expect(p.cursor).toBeNull();
    p = placeEvent(p.cursor, at(23, 19), true);
    expect(p.night).toBe('2026-10-23');
    cur = p.cursor;
    p = placeEvent(cur, at(24, 1, 50), true);
    expect(p.night).toBe('2026-10-23');
    p = placeEvent(p.cursor, at(24, 2, 30), false); // offline after the last run
    expect(p.night).toBe('2026-10-23');
    p = placeEvent(p.cursor, at(24, 19), true); // the next evening
    expect(p.night).toBe('2026-10-24');
    expect(p.cursor).toEqual({ night: '2026-10-24', lastRun: at(24, 19) });
  });
});

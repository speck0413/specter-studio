// Show nights. Boards are powered up for a night's show and off afterwards, and a show runs past midnight
// (7 pm to 2 am), so a night is never a calendar day: it is a session that starts at the first run after a gap
// of NIGHT_GAP_MS or more, and it is named after the evening it started on (a first run before
// NIGHT_STARTS_AT_HOUR belongs to the evening before).
import type { FeedEvent } from './events';

/** A quiet time this long between two runs starts a new night. */
export const NIGHT_GAP_MS = 4 * 60 * 60 * 1000;
/** A night whose first run comes before this hour (local time) is named after the day before: a run at 1 am
 * after a quiet evening still belongs to that evening. */
export const NIGHT_STARTS_AT_HOUR = 12;

const pad = (n: number) => String(n).padStart(2, '0');

/** The evening a moment belongs to, `YYYY-MM-DD` in local time. */
export function eveningOf(t: number): string {
  const d = new Date(t);
  if (d.getHours() < NIGHT_STARTS_AT_HOUR) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Where the log is: the night now being written and its last run. */
export interface NightCursor { night: string; lastRun: number }

/** The night an event at `t` goes into, and the cursor after it. A run more than NIGHT_GAP_MS after the last
 * one starts a new night; any other event goes into the running night while it lasts (a board going offline at
 * 2:30 am), else into its own evening's night. */
export function placeEvent(cur: NightCursor | null, t: number, isRun: boolean): { night: string; cursor: NightCursor | null } {
  const running = cur && t - cur.lastRun < NIGHT_GAP_MS && t >= cur.lastRun - NIGHT_GAP_MS;
  if (isRun) {
    const night = running ? cur!.night : eveningOf(t);
    return { night, cursor: { night, lastRun: Math.max(t, running ? cur!.lastRun : 0) } };
  }
  return { night: running ? cur!.night : eveningOf(t), cursor: cur };
}

export interface Night {
  /** the evening's date, YYYY-MM-DD */
  night: string;
  /** the first and last run */
  first: number;
  last: number;
  runs: number;
  /** runs per board */
  boards: Record<string, number>;
}

/** Runs grouped into nights (a gap of NIGHT_GAP_MS between runs starts the next), oldest first. Events that are not
 * runs are left out of the totals. */
export function groupNights(events: FeedEvent[]): Night[] {
  const runs = events.filter((e) => e.type === 'run').sort((a, b) => a.t - b.t);
  const out: Night[] = [];
  for (const e of runs) {
    let n = out[out.length - 1];
    if (!n || e.t - n.last >= NIGHT_GAP_MS) {
      n = { night: eveningOf(e.t), first: e.t, last: e.t, runs: 0, boards: {} };
      out.push(n);
    }
    n.last = e.t;
    n.runs++;
    n.boards[e.board] = (n.boards[e.board] || 0) + 1;
  }
  return out;
}

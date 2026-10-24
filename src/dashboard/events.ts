// The Dashboard's events in plain words: what a board pushed (directly or over Studio's MQTT server) turned into
// one feed line each, and the run counters a board reports (firmware PROTOCOL.md "Run counters").

export type FeedType = 'run' | 'status' | 'online' | 'settings' | 'error' | 'log';
export const FEED_TYPES: { type: FeedType; label: string }[] = [
  { type: 'run', label: 'Runs' },
  { type: 'status', label: 'Status' },
  { type: 'online', label: 'Online / offline' },
  { type: 'settings', label: 'Settings' },
  { type: 'error', label: 'Errors' },
  { type: 'log', label: 'Other' },
];

export interface FeedEvent {
  /** when Studio heard it (ms since 1970) */
  t: number;
  /** the board's name as Studio shows it */
  board: string;
  type: FeedType;
  text: string;
  /** a run: what started it (input, release, api, cue, timer, boot, after), what ran (show, script, effect) */
  source?: string;
  kind?: string;
  name?: string;
  detail?: string;
  runs_tonight?: number;
  runs_lifetime?: number;
  /** how the board reached Studio */
  via?: 'direct' | 'mqtt';
}

/** The words for what started a run. */
export function sourceWords(source?: string, detail?: string): string {
  switch (source) {
    case 'input': return detail ? `${detail} pressed` : 'an input';
    case 'release': return detail ? `${detail} let go` : 'an input let go';
    case 'api': return 'from Studio, the web page or MQTT';
    case 'cue': return detail ? `cue “${detail}”` : 'a cue';
    case 'timer': return 'its timer';
    case 'boot': return 'power-on';
    case 'after': return 'after another show';
    default: return source || 'unknown';
  }
}

/** The text of a run event's data. */
export function runText(d: any): string {
  const what = d.kind === 'effect' ? 'The built-in effect' : d.kind === 'script' ? `Effect “${d.name}”` : d.name ? `Show “${d.name}”` : `Show ${d.show ?? ''}`.trim();
  return `${what} ran (${sourceWords(d.source, d.detail)})`;
}

const ERROR_WORDS = /fail|error|could not|cannot|refused|not answer|watchdog|full/i;

/** A board's pushed message (`{"event": ..., "data": ...}`) as a feed line, or null for what the feed leaves out
 * (states, which the tiles show). `legacyRuns`: the board's firmware has no run counters, so a show starting
 * (a `started` notice) counts as its run. */
export function fromBoardMsg(board: string, msg: any, t: number, legacyRuns = false, via: FeedEvent['via'] = 'direct'): FeedEvent | null {
  if (!msg || typeof msg !== 'object') return null;
  const d = msg.data;
  const base = { t, board, via };
  switch (msg.event) {
    case 'run':
      if (!d || typeof d !== 'object') return null;
      return { ...base, type: 'run', text: runText(d), source: d.source, kind: d.kind, name: d.name, detail: d.detail,
        runs_tonight: num(d.runs_since_power_on), runs_lifetime: num(d.runs_lifetime) };
    case 'notice': {
      if (!d) return null;
      if (d.notice === 'started') {
        if (!legacyRuns) return null; // the run event says it (with the counts)
        return { ...base, type: 'run', text: `Show ${d.show} ran (${sourceWords(d.cause?.by, d.cause?.detail)})`, source: d.cause?.by, kind: 'show', detail: d.cause?.detail };
      }
      if (d.notice === 'ended') return { ...base, type: 'status', text: `Show ${d.show} ended (${d.reason === 'released' ? 'let go' : d.reason})` };
      if (d.notice === 'ignored') return { ...base, type: 'status', text: `A trigger was ignored (${d.why})` };
      if (d.notice === 'watchdog') return { ...base, type: 'error', text: `${d.channel || 'An output'} was switched off: it reached its max on-time` };
      if (d.notice === 'interlock') return { ...base, type: 'error', text: `${d.channel || 'An output'} was held off by an interlock` };
      if (d.notice === 'paused') return { ...base, type: 'status', text: d.paused ? 'Stopped: triggers are ignored' : 'Resumed' };
      return { ...base, type: 'status', text: `Notice: ${d.notice}` };
    }
    case 'params_changed': return { ...base, type: 'settings', text: 'Settings changed' };
    case 'script_changed': return { ...base, type: 'settings', text: 'The effect script changed' };
    case 'shows_changed': return { ...base, type: 'settings', text: 'The shows changed' };
    case 'update':
      return { ...base, type: d?.phase === 'failed' ? 'error' : 'status', text: `Firmware update: ${d?.phase}${d?.message ? ': ' + d.message : ''}` };
    case 'log': {
      const text = String(d ?? '');
      if (/^run #\d+/.test(text)) return null; // the effect's own line for a run: the run event says it
      return { ...base, type: ERROR_WORDS.test(text) ? 'error' : 'log', text };
    }
    default:
      return null;
  }
}

/** A board coming online or going offline. */
export function onlineEvent(board: string, online: boolean, t: number, via: FeedEvent['via'] = 'direct'): FeedEvent {
  return { t, board, type: 'online', text: online ? 'Online' : 'Offline', via };
}

const num = (v: any) => (typeof v === 'number' ? v : undefined);

/** The run counters in a board's state (or an MQTT board's retained status values); null for a firmware without them. */
export interface Counts { tonight: number; lifetime: number; lastRunUptime?: number; uptime?: number }
export function countsOf(state: any, status?: any): Counts | null {
  const pick = (k: string) => (typeof state?.[k] === 'number' ? state[k] : typeof status?.[k] === 'number' ? status[k] : undefined);
  const tonight = pick('runs_since_power_on');
  if (tonight === undefined) return null;
  const last = pick('last_run_uptime_ms');
  return { tonight, lifetime: pick('runs_lifetime') ?? 0, lastRunUptime: last !== undefined && last >= 0 ? last : undefined, uptime: num(state?.uptime_ms) };
}

/** The board's name as the MQTT topics have it (`Front Door` -> `front-door`), to match a board Studio has a direct
 * session with to the same board reporting over MQTT. */
export function topicLabel(name: string): string {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** "2 min ago", "just now", "3 h ago". */
export function ago(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} days ago`;
}

/** "2 min ago (21:04)": relative and clock time of a moment. */
export function whenText(t: number | undefined, now: number): string {
  if (!t) return 'not yet';
  return `${ago(t, now)} (${new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
}

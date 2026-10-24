// Automation (Settings): "When a message arrives on … send a web request to …" rules and the connection to
// another MQTT server. The device layer checks, keeps and runs the rules (core/src/automation); this file holds
// the UI's side: the shapes, a new rule, the ready-made examples with fresh ids, the words for statuses, and the
// bridge settings kept in prefs.

export type Method = 'POST' | 'GET' | 'PUT';
export type ContentType = 'csv' | 'json' | 'form';
export type Pairing = 'latest' | 'first_in_first_out';

export interface HeaderSpec { name: string; value: string; secret: boolean }
export interface CountSpec { direction: 'up' | 'down'; name: string; by: string; per: string }
export interface TimerSpec { role: 'start' | 'complete'; name: string; per: string; pairing: Pairing }

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  pattern: string;
  method: Method;
  url: string;
  headers: HeaderSpec[];
  body: string;
  content_type: ContentType;
  count?: CountSpec;
  timer?: TimerSpec;
  /** a query parameter whose value is secret (`key` for `?key=…`): kept in the keychain, added when sending */
  secret_param?: string;
}

/** `resend`: the request's number for "Send again" (failed, or may have been sent). */
export interface LogEntry { at: string; ok: boolean; status?: number; text: string; resend?: number }
export interface RuleStatus {
  queued?: number; sent?: number; failed?: number; unsure?: number; dropped?: number; limited?: number;
  log?: LogEntry[]; problem?: string; counts?: Record<string, number>; open_starts?: Record<string, number>;
}

export const CONTENT_TYPES: { id: ContentType; label: string }[] = [
  { id: 'csv', label: 'A line of a spreadsheet (CSV)' },
  { id: 'json', label: 'JSON' },
  { id: 'form', label: 'A web form (as a Google Form takes)' },
];

export const PAIRINGS: { id: Pairing; label: string }[] = [
  { id: 'latest', label: 'The latest start (one group at a time)' },
  { id: 'first_in_first_out', label: 'The oldest open start (groups go through in order)' },
];

/** The values every rule has, for the help under the body. */
export const BUILT_IN_VALUES = ['{event_id}', '{topic}', '{payload}', '{payload.field}', '{timestamp}', '{date}', '{time}', '{unix}'];
export const TIMER_VALUES = ['{elapsed}', '{elapsed_text}', '{started_at}', '{sequence}'];

let counter = 0;
/** A new id that no other rule has (time plus a counter). */
export function newId(prefix = 'rule'): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

export function newRule(): Rule {
  return {
    id: newId(), name: '', enabled: true, pattern: 'checkin/*/{roomName}/complete', method: 'POST', url: '', headers: [],
    body: '{roomName},complete,{timestamp}', content_type: 'csv',
  };
}

/** An example's rules, ready to add: fresh ids (an example can be added twice) and switched off until the
 * person pastes their own web address. */
export function fromExample(rules: Rule[]): Rule[] {
  return rules.map((r) => ({ ...r, id: newId(r.id), enabled: false, headers: r.headers.map((h) => ({ ...h })) }));
}

/** The names a topic pattern keeps (`{roomName}`), for the "for each" choices. */
export function patternNames(pattern: string): string[] {
  return pattern.split('/').filter((l) => /^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(l)).map((l) => l.slice(1, -1));
}

/** "When a message arrives on <pattern>, send a POST request to script.google.com." */
export function ruleSummary(r: Rule): string {
  let host = r.url;
  try { host = new URL(r.url).host || r.url; } catch { /* not an address yet */ }
  return `When a message arrives on ${r.pattern || '…'}, send a ${r.method} request to ${host || '…'}.`;
}

/** The rule's counters and timers in words, or ''. */
export function stateSummary(r: Rule, st?: RuleStatus): string {
  const parts: string[] = [];
  if (r.count) {
    const c = st?.counts || {};
    const keys = Object.keys(c);
    const now = keys.length === 0 ? '0' : keys.map((k) => (k ? `${k}: ${c[k]}` : String(c[k]))).join(', ');
    parts.push(`Counts ${r.count.direction} ${r.count.name}${r.count.per ? ` for each ${r.count.per}` : ''} (now ${now})`);
  }
  if (r.timer) {
    const open = Object.values(st?.open_starts || {}).reduce((a, b) => a + b, 0);
    parts.push(r.timer.role === 'start' ? `Starts timer ${r.timer.name} (${open} waiting to finish)` : `Finishes timer ${r.timer.name}`);
  }
  return parts.join('. ');
}

/** "Sent 12, failed 1, 3 waiting, 2 skipped (too many)". */
export function countsText(st?: RuleStatus): string {
  if (!st) return '';
  const p = [`Sent ${st.sent || 0}`];
  if (st.failed) p.push(`failed ${st.failed}`);
  if (st.unsure) p.push(`${st.unsure} may have been sent (check the sheet)`);
  if (st.queued) p.push(`${st.queued} waiting`);
  if (st.dropped) p.push(`${st.dropped} dropped (too many waiting)`);
  if (st.limited) p.push(`${st.limited} skipped (too many a minute)`);
  return p.join(', ');
}

/** `21:04:05` from a log entry's time. */
export function logTime(at: string): string {
  const m = /T(\d\d:\d\d:\d\d)/.exec(at);
  return m ? m[1] : at;
}

/** Whether a log entry offers "Send again". */
export function canSendAgain(l: LogEntry): boolean {
  return typeof l.resend === 'number';
}

/** The key "set / not set" is kept under for a rule's secret address part. */
export function paramSecretKey(ruleId: string, param: string): string {
  return `${ruleId}:?${param}`;
}

/** A secret's state in words: the value itself is never shown. */
export function secretLabel(set: boolean | undefined): string {
  return set ? 'set' : 'not set';
}

/** What a rule looks like in an export: no secret values (the device layer leaves them out as well). */
export function withoutSecrets(r: Rule): Rule {
  // the secret address part keeps its name only (its value is never in a rule)
  return { ...r, headers: r.headers.map((h) => (h.secret ? { ...h, value: '' } : { ...h })) };
}

export function updateRule(rules: Rule[], id: string, patch: Partial<Rule>): Rule[] {
  return rules.map((r) => (r.id === id ? { ...r, ...patch } : r));
}

export function removeRule(rules: Rule[], id: string): Rule[] {
  return rules.filter((r) => r.id !== id);
}

/** Puts `rule` in the list: replaces the one with its id, else adds it at the end. */
export function upsertRule(rules: Rule[], rule: Rule): Rule[] {
  return rules.some((r) => r.id === rule.id) ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule];
}

// ---------- the connection to another MQTT server (prefs.bridge) ----------

export type Direction = 'out' | 'in' | 'both';
export interface BridgePrefs {
  on: boolean; host: string; port: number; tls: boolean; username: string; prefix: string; accept_commands: boolean;
  direction: Direction; filters: string[];
}
export const NO_BRIDGE: BridgePrefs = { on: false, host: '', port: 1883, tls: false, username: '', prefix: '', accept_commands: false, direction: 'out', filters: ['#'] };

export const DIRECTIONS: { id: Direction; label: string }[] = [
  { id: 'out', label: 'Send from Studio to that server' },
  { id: 'in', label: 'Take from that server into Studio' },
  { id: 'both', label: 'Both ways' },
];

/** Saved bridge settings with today's fields (settings from before directions and filters send everything out). */
export function bridgePrefs(saved: any): BridgePrefs {
  const b = { ...NO_BRIDGE, ...(saved || {}) };
  if (!['out', 'in', 'both'].includes(b.direction)) b.direction = 'out';
  b.filters = Array.isArray(b.filters) ? b.filters.map((f: any) => String(f).trim()).filter(Boolean) : [];
  if (b.filters.length === 0) b.filters = ['#'];
  // a password never lives in prefs (it is in the system keychain)
  delete (b as any).password;
  return b;
}

/** "site/#, checkin/+" (commas, spaces or new lines) as a list; empty means everything. */
export function parseFilters(text: string): string[] {
  const f = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return f.length ? f : ['#'];
}

/** The bridge's status in plain words. */
export function bridgeStatusText(st: any): string {
  if (!st) return 'Not connected.';
  if (st.state === 'connected' || (st.connected && !st.state)) {
    const n = [st.sent ? `${st.sent} sent` : '', st.received ? `${st.received} received` : '', st.refused ? `${st.refused} requests to boards refused` : ''].filter(Boolean).join(', ');
    return `Connected to ${st.host}.${n ? ` ${n[0].toUpperCase()}${n.slice(1)}.` : ''}`;
  }
  if (st.state === 'retrying') {
    const kept = st.buffered ? ` Keeping the latest reports (${st.buffered}) until it is back.` : '';
    return `Not connected: ${st.last_error || 'the server cannot be reached.'} Trying again in ${st.retry_in_s ?? 0} s.${kept}`;
  }
  return `Connecting to ${st.host}…`;
}

// What a plugin may do on Studio's MQTT server, from its plugin.json:
//   "mqtt": ["prefix/#"]                                   subscribe and publish there (the short form)
//   "mqtt": {"subscribe": [...], "publish": [...], "actions": [...]}
// "actions" are publish topics that make a device do something (fire, a setting): the person agrees once per
// plugin, and every one is written to the activity log. "http": true: requests to local-network devices.
// "control": true: the plugin may make boards act (run and stop shows, test outputs, sounds, pixels, some
// settings); without it a plugin only reads. Every control request is written to the activity log.
// "firmware": [{fw, name, source}]: firmware types the plugin adds, each with its own release list (firmware.ts).
// "board_packages": ["dir/x.json"], "profiles": [{name, file}], "scripts": [{name, file}]: files the plugin offers
// for boards (boardPackages.ts), sent to a board only when the person picks them.
export interface FirmwareOffer { fw: string; name: string; source: string }
export interface BoardFileOffers { board_packages: string[]; profiles: { name: string; file: string }[]; scripts: { name: string; file: string }[] }
export interface Perms { subscribe: string[]; publish: string[]; actions: string[]; http: boolean; control: boolean; firmware: FirmwareOffer[]; boardFiles: BoardFileOffers }

function boardFileOffers(plugin: any): BoardFileOffers {
  const named = (l: any) => (Array.isArray(l) ? l : []).filter((f: any) => typeof f?.file === 'string').map((f: any) => ({ name: String(f.name ?? f.file), file: f.file }));
  return {
    board_packages: (Array.isArray(plugin?.board_packages) ? plugin.board_packages : []).filter((f: any) => typeof f === 'string'),
    profiles: named(plugin?.profiles),
    scripts: named(plugin?.scripts),
  };
}
/** Whether a plugin offers any board package, profile or script. */
export const offersBoardFiles = (o: BoardFileOffers) => o.board_packages.length + o.profiles.length + o.scripts.length > 0;

function firmwareOffers(plugin: any): FirmwareOffer[] {
  return (Array.isArray(plugin?.firmware) ? plugin.firmware : [])
    .filter((f: any) => typeof f?.fw === 'string' && typeof f?.name === 'string')
    .map((f: any) => ({ fw: f.fw, name: f.name, source: String(f.source ?? '') }));
}

export function perms(plugin: any): Perms {
  const m = plugin?.mqtt;
  const control = plugin?.control === true;
  const firmware = firmwareOffers(plugin);
  const boardFiles = boardFileOffers(plugin);
  if (Array.isArray(m)) return { subscribe: m, publish: m, actions: [], http: !!plugin.http, control, firmware, boardFiles };
  return { subscribe: m?.subscribe || [], publish: m?.publish || [], actions: m?.actions || [], http: !!plugin?.http, control, firmware, boardFiles };
}

// ---------------------------------------------------------------- board requests from a plugin
/** Requests every plugin may send: reading only. */
export const READ_OPS = new Set(['info', 'state', 'list_shows', 'get_show', 'get_params', 'get_profile', 'get_script', 'check_script']);
/** Requests that make a board act: only with "control" (agreed on the consent screen, each one logged). */
export const CONTROL_OPS = new Set(['run', 'stop', 'stop_all', 'pause', 'cue', 'set_output', 'pixel', 'sound', 'action', 'set_params', 'sim_input']);
// settings a plugin never changes, even with "control": identity, access, network, safety limits and roles. The
// key must also be exactly a key the board lists (get_params): an alias (a profile's other name) is refused, so
// a setting cannot be reached under a name this list does not know.
const NEVER = /^(pin|page_lock|name|wifi_.*|ap_.*|mqtt_.*|topic_prefix|.*_max_on_ms|interlock_.*|trig\d(_input)?|.*_role|buttons|effect|record_show|remote_trigger.*|df_.*|dmx.*|status_led|label_.*)$/;

/** Why a plugin's board request is refused, or null when it may go to the board. `keys`: the board's own
 * setting keys (get_params), needed only for set_params. `aliasOf`: the board's profile, alias -> the setting it
 * names (get_profile): with a profile, get_params lists a setting under its alias, and the rule is checked on the
 * setting itself, so a profile's other name never opens a setting plugins may not change. */
export function refusal(req: any, p: Perms, keys?: string[], aliasOf?: Record<string, string>): string | null {
  const op = req?.op;
  if (READ_OPS.has(op)) return null;
  if (!CONTROL_OPS.has(op)) return `${op} is not available to plugins`;
  if (!p.control) return `${op} needs the "control" permission (plugin.json "control": true)`;
  if (op === 'set_params') {
    const values = Array.isArray(req.values) ? req.values : [];
    if (!values.length) return 'no settings given';
    for (const v of values) {
      const k = String(v?.key ?? '');
      if (NEVER.test(k) || NEVER.test(aliasOf?.[k] ?? '')) return `plugins cannot change ${k}`;
      if (!keys?.includes(k)) return `${k} is not a setting of this board`;
    }
  }
  return null;
}

/** alias -> setting key from a board's get_profile answer (its key aliases only). */
export function aliasTargets(profile: any): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of profile?.aliases || []) if (typeof a?.alias === 'string' && typeof a?.key === 'string') out[a.alias] = a.key;
  return out;
}

/** What plugin.json asks for, as one string: consent is remembered for exactly this (and this folder). */
export function fingerprint(plugin: any): string {
  const { firmware, boardFiles, ...rest } = perms(plugin);
  // without firmware or board file offers the string is what it was before they existed: those plugins are not
  // asked again
  const p = { ...rest, ...(firmware.length ? { firmware } : {}), ...(offersBoardFiles(boardFiles) ? { boardFiles } : {}) };
  const s = JSON.stringify({ dir: plugin?.dir || '', adapter: plugin?.adapter || '', entry: plugin?.entry || '', p });
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** MQTT topic filter match (+ one level, # the rest). */
export function topicMatches(filter: string, topic: string) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (i >= t.length || (f[i] !== '+' && f[i] !== t[i])) return false;
  }
  return f.length === t.length;
}

/** A subscription filter inside an allowed filter. */
export function within(allowed: string, filter: string) {
  return topicMatches(allowed, filter.replace(/\+/g, 'x').replace(/#$/, 'x/y'));
}

export const canSubscribe = (p: Perms, filter: string) => p.subscribe.some((f) => within(f, filter));
export const canPublish = (p: Perms, topic: string) => [...p.publish, ...p.actions].some((f) => topicMatches(f, topic)) && !/[+#]/.test(topic);
export const isAction = (p: Perms, topic: string) => p.actions.some((f) => topicMatches(f, topic));

/** The permissions in plain words, for the consent screen. */
export function describePerms(p: Perms): string[] {
  const out: string[] = [];
  if (p.subscribe.length) out.push(`Read messages on: ${p.subscribe.join(', ')}`);
  if (p.publish.length) out.push(`Send messages on: ${p.publish.join(', ')}`);
  if (p.actions.length) out.push(`Make devices act (each one is logged): ${p.actions.join(', ')}`);
  if (p.http) out.push('Talk to devices on this network');
  if (p.control) out.push('Control boards: run and stop shows, test outputs, play sounds, change some settings (each one is logged)');
  if (p.firmware.length) out.push(`Offer firmware for your boards: ${p.firmware.map((f) => f.name).join(', ')} (Studio installs it only when you choose it)`);
  const b = p.boardFiles;
  if (offersBoardFiles(b)) {
    const parts = [b.board_packages.length && `${b.board_packages.length} board package${b.board_packages.length === 1 ? '' : 's'}`,
      b.profiles.length && `profiles (${b.profiles.map((f) => f.name).join(', ')})`, b.scripts.length && `scripts (${b.scripts.map((f) => f.name).join(', ')})`].filter(Boolean);
    out.push(`Offer for your boards: ${parts.join(', ')} (Studio sends them to a board only when you choose them)`);
  }
  return out;
}

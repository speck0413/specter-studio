// Start fresh (the board's factory_reset): its firmware's (and board package's) default settings and script. Studio
// offers it where people look for it: a banner when a board runs another firmware or board package than Studio last
// saw (its stored settings and script are then from the previous one), and a permanent section in the board's
// Settings tab. Pure parts here, tested in freshStart.test.ts; the banner and section are in components/StartFresh.tsx.

/** What a board runs, as Studio remembers it per board id: its firmware type and board package. */
export interface FirmwareSig { fw: string; board: string }
/** The board package of a board that names none (firmware.ts DEFAULT_BOARD). */
const DEFAULT_BOARD = 'proptroller';

export const sigOf = (info: any): FirmwareSig | null =>
  info?.id && typeof info?.fw === 'string' && info.fw ? { fw: info.fw, board: typeof info.board === 'string' && info.board ? info.board : DEFAULT_BOARD } : null;

const same = (a: FirmwareSig, b: FirmwareSig) => a.fw === b.fw && a.board === b.board;
/** The key "Keep mine" is remembered under: this board, on exactly this firmware and board package. */
export const keptKey = (id: string, s: FirmwareSig) => `${id}|${s.fw}|${s.board}`;

/** The boards Studio sees for the first time (or that have no id yet) are remembered as they are: no banner. */
export function noteFirstSeen(seen: Record<string, FirmwareSig>, infos: any[]): Record<string, FirmwareSig> | null {
  let next: Record<string, FirmwareSig> | null = null;
  for (const info of infos) {
    const s = sigOf(info);
    if (!s || seen[info.id] || next?.[info.id]) continue;
    next = { ...(next || seen), [info.id]: s };
  }
  return next;
}

export interface FirmwareChange { from: FirmwareSig; to: FirmwareSig; typeChanged: boolean }

/** A board that now runs another firmware type or board package than Studio last saw, unless the person chose to
 * keep its settings on exactly this one ("Keep mine"). */
export function firmwareChange(seen: Record<string, FirmwareSig> | undefined, kept: Record<string, boolean> | undefined, info: any): FirmwareChange | null {
  const to = sigOf(info);
  const from = to && seen?.[info.id];
  if (!to || !from || same(from, to) || kept?.[keptKey(info.id, to)]) return null;
  return { from, to, typeChanged: from.fw !== to.fw };
}

/** The banner's words. `typeName`: the firmware's name for people; `pkgName`: the board package's, when only that
 * changed. */
export function changeWords(c: FirmwareChange, typeName: string, pkgName?: string) {
  const what = c.typeChanged ? typeName : `the board package ${pkgName || c.to.board}`;
  return {
    text: `This board now runs ${what}. Its stored script and settings are from the previous ${c.typeChanged ? 'firmware' : 'board package'}. Start fresh to load ${what}'s defaults?`,
    fresh: 'Start fresh…',
    keep: 'Keep mine',
  };
}

/** What a board package's own defaults hold (board_files `defaults`), in words; '' when there are none or Studio
 * cannot tell. */
export function defaultsWords(d: { settings?: number; profile?: boolean; script?: boolean } | undefined): string {
  if (!d) return '';
  const parts = [d.settings ? `${d.settings} setting${d.settings === 1 ? '' : 's'}` : '', d.profile ? 'its own words for the terminals (a profile)' : '', d.script ? 'an effect script' : ''].filter(Boolean);
  if (!parts.length) return '';
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** How long Studio waits for a board to answer again after it started fresh, to give it back its name and Wi-Fi. */
export const FRESH_BACK_WAIT_MS = 30_000;
export const FRESH_FIRST_WAIT_MS = 2000;

/** The set_params that give a board back its name and Wi-Fi network after it started fresh (the password typed
 * again: Studio never reads it from a board). A network and its password go together (PROTOCOL.md set_params). */
export function keepValues(keep: { name?: string; ssid?: string; pass?: string }): { key: string; value: string }[] {
  return [...(keep.name ? [{ key: 'name', value: keep.name }] : []), ...(keep.ssid ? [{ key: 'wifi_ssid', value: keep.ssid }, { key: 'wifi_pass', value: keep.pass || '' }] : [])];
}

/** get_defaults' answer (firmware capability `defaults`). */
export interface BoardDefaults { kind: 'defaults'; source: 'board_package' | 'firmware' | 'none'; board?: string; profile?: any; settings?: Record<string, unknown>; script?: string; script_name?: string }
export const DEFAULTS_CAPABILITY = 'defaults';
export const hasDefaultsOp = (info: any) => Array.isArray(info?.capabilities) && info.capabilities.includes(DEFAULTS_CAPABILITY);

/** The focused question after a change of firmware type or board package, when the new one has its own script
 * (null: it has none, so nothing is asked). */
export function scriptQuestion(d: BoardDefaults | null | undefined, typeName: string) {
  if (!d?.script || !d.script.trim()) return null;
  const named = d.script_name ? ` (“${d.script_name}”)` : ' (its own script)';
  return {
    text: `${typeName} comes with its own script${named}. Use it, or keep the script that's on the board now?`,
    use: `Use ${typeName}'s script`,
    keep: 'Keep my script',
    // apply_defaults: the script, and the profile its words come from when the defaults have one
    only: d.profile ? ['script', 'profile'] : ['script'],
    also: d.profile ? ' and its own words for the terminals (its profile)' : '',
  };
}

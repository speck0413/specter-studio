// Firmware types (docs/DESIGN.md "Firmware types"): the stock firmware, plus the types allowed plugins add in
// their plugin.json ("firmware": [{fw, name, source}]). A board's updates follow the type it reports; installing
// another type is a switch the person picks and confirms. The device layer merges the lists (firmware_catalog).
import { fingerprint, offersBoardFiles, perms } from './components/pluginPerms';

export const GENERIC = 'generic';
export const GENERIC_NAME = 'Generic (stock)';
/** The board package (BSP) of a board or a list entry that names none: the Proptroller board. */
export const DEFAULT_BOARD = 'proptroller';
/** What the USB install says when no firmware image is there at all (nothing published, no folder chosen). */
export const NO_FIRMWARE_YET = 'No firmware found yet (no release published).';
/** The device layer's words for a list with nothing published (fleet::NO_RELEASE). */
const NO_RELEASE = 'there is no firmware release there yet';

export const boardOf = (x: any): string => (typeof x?.board === 'string' && x.board ? x.board : DEFAULT_BOARD);

/** A kind of board a firmware goes on: its board package and its chip (info.board + info.mcu). */
export interface BoardKind { board: string; mcu: string; key: string; boardName: string }
const kindKey = (board: string, mcu: string) => `${board}/${mcu}`;

/** firmware_catalog's answer */
export interface Catalog {
  types: { fw: string; name: string; plugin: { id: string; name: string } | null; version?: string; prerelease?: boolean; bundled?: boolean; error?: string }[];
  images: any[];
}

/** A plugin that offers firmware types, or board packages, profiles or scripts (boardPackages.ts). */
const offersFirmware = (p: any) => (Array.isArray(p?.firmware) && p.firmware.length > 0) || offersBoardFiles(perms(p).boardFiles);
const allowed = (p: any, consent: Record<string, string | boolean> | undefined) => consent?.[p.id] === fingerprint(p);

/** The ids of the plugins whose firmware lists and board files Studio may use: they offer some and the person
 * allowed exactly that. */
export function firmwarePlugins(plugins: any[], consent?: Record<string, string | boolean>): string[] {
  return plugins.filter((p) => offersFirmware(p) && allowed(p, consent)).map((p) => p.id);
}

/** What every firmware request sends the device layer: the stock list's source, the allowed plugins' ids, and
 * whether pre-releases may be offered (Settings "Allow betas", off unless turned on). */
export function firmwareArgsOf(prefs: { releases?: string; betas?: boolean; pluginConsent?: Record<string, string | boolean> }, plugins: any[]) {
  return { source: prefs.releases || '', plugins: firmwarePlugins(plugins, prefs.pluginConsent), betas: prefs.betas === true };
}

/** Plugins that offer firmware but are not allowed (yet): Settings lists them with an Allow button. */
export function waitingFirmwarePlugins(plugins: any[], consent?: Record<string, string | boolean>): any[] {
  return plugins.filter((p) => offersFirmware(p) && !allowed(p, consent));
}

export interface TypeOption { fw: string; name: string; disabled: boolean; note: string }

/** The dropdown's choices, the stock firmware first. `mcu` (and `board`, the board package, default the Proptroller
 * board): only types with an image for that kind of board can be picked; `firstFlash`: a USB install (else an
 * update over Wi-Fi); `current`: the type the board runs now. */
export function typeOptions(c: Catalog | null, o: { mcu?: string; board?: string; firstFlash?: boolean; current?: string } = {}): TypeOption[] {
  if (!c) return [];
  const board = o.board || DEFAULT_BOARD;
  return c.types.map((t) => {
    const imgs = c.images.filter((i) => i.fw === t.fw && (o.firstFlash ? i.first_flash === true : i.first_flash !== true));
    const fits = o.mcu ? imgs.some((i) => i.mcu === o.mcu && boardOf(i) === board) : imgs.length > 0;
    // the type on the board is shown as such (picking it again changes nothing), whatever its list holds
    if (o.current === t.fw) return { fw: t.fw, name: t.name, disabled: false, note: 'On the board now' };
    let note = '';
    if (t.error === NO_RELEASE) note = 'No release published yet';
    else if (t.error) note = `Cannot read its firmware list: ${t.error}`;
    else if (!fits) note = o.firstFlash ? (o.mcu ? 'No USB install for this kind of board' : 'No USB install in its list') : 'No firmware for this kind of board';
    else if (t.plugin) note = `From the extension “${t.plugin.name}”`;
    // the generic release that comes with Studio (no newer one downloaded): there offline and before any release
    else if (t.bundled) note = `${t.version} comes with Studio`;
    if (!t.error && fits && t.prerelease) note = note ? `${note} · beta (a test version)` : 'Beta (a test version)';
    return { fw: t.fw, name: t.name, disabled: !!t.error || !fits, note };
  });
}

/** The kinds of board (board package + chip) a type can be installed on over USB, in list order. A list entry may
 * name its board package for people (`board_name`); else the Proptroller board is "Proptroller board" and any other
 * package goes by its id. */
export function firstFlashBoards(c: Catalog | null, fw: string): BoardKind[] {
  const out: BoardKind[] = [];
  for (const i of (c?.images || []).filter((x) => x.fw === fw && x.first_flash === true)) {
    const board = boardOf(i), mcu = String(i.mcu), key = kindKey(board, mcu);
    if (out.some((k) => k.key === key)) continue;
    out.push({ board, mcu, key, boardName: typeof i.board_name === 'string' && i.board_name ? i.board_name : board === DEFAULT_BOARD ? 'Proptroller board' : board });
  }
  return out;
}

/** A board's board package for people: the name its firmware list gives it (`board_name`), "Proptroller board" for
 * the Proptroller board's own map (also a board that reports none), else the package's id. */
export function boardPackageName(info: any, plan?: any): string {
  if (typeof plan?.image?.board_name === 'string' && plan.image.board_name) return plan.image.board_name;
  const b = boardOf(info);
  return b === DEFAULT_BOARD ? 'Proptroller board' : b;
}

/** What a board runs, for its badge: a type Studio has a list for (the update plan names it) is a release, also
 * when it is not the stock firmware; a firmware named like one of the library's own sketches stays "your
 * firmware"; any other name is a custom firmware. `custom`: identify_firmware's answer. */
export function firmwareKind(custom: any, plan: any): any {
  if (custom?.kind === 'custom' && custom.status === 'unknown' && plan?.type_name) return { kind: 'release' };
  return custom || { kind: 'release' };
}

/** A type's friendly name; a firmware Studio has no list for keeps its own name. */
export function typeName(c: Catalog | null, fw: string | undefined): string {
  if (!fw) return 'unknown';
  return c?.types.find((t) => t.fw === fw)?.name || (fw === GENERIC ? GENERIC_NAME : fw);
}

/** The confirmation for starting a board fresh with its firmware's own defaults (the firmware's factory_reset).
 * `pkg`: for a board that takes board packages, whether its stored package is kept (its defaults then apply) or
 * forgotten (`forget_board`). */
export function freshWords(board: string, type: string, pkg?: 'keep' | 'forget', keepNet: boolean | 'board' = false) {
  const what = pkg === 'keep' ? `what its board package and the ${type} firmware set up on a new board (the board package is kept)`
    : pkg === 'forget' ? `the ${type} firmware's own setup for a new board: its stored board package is forgotten too, and it goes back to its built-in one`
    : `what the ${type} firmware sets up on a new board`;
  return {
    title: `Start ${board} fresh with the ${type} firmware's defaults?`,
    text: keepNet === 'board'
      ? `${board} erases its settings, shows and effect script, restarts, and starts with ${what}. It keeps its name and its Wi-Fi network and password, and comes back on your network. Back it up first if you want to keep anything else.`
      : keepNet
      ? `${board} erases its settings, shows, effect script and page password, restarts, and starts with ${what}. Then Studio gives it back its name and Wi-Fi network (when it can still reach it: always over USB). Back it up first if you want to keep anything else.`
      : `${board} erases its settings, shows, effect script, page password and Wi-Fi, restarts, and starts with ${what}. Back it up first if you want to keep anything (Studio backed it up before a change of firmware). Afterwards it is no longer on your Wi-Fi: join its own Wi-Fi (“Proptroller-…”) or plug it in with USB to set it up again.`,
  };
}

/** The confirmation for a switch of type: it names both and says what happens to the settings. */
export function switchWords(board: string, from: string, to: string) {
  return {
    title: `Replace the ${from} firmware on ${board} with ${to}?`,
    text: `${board} gets different firmware: it restarts, and its settings, shows and effect script from the ${from} firmware may not carry over. Studio saves a backup of them to your backups folder first (when the board can give one). Later updates follow the ${to} firmware.`,
  };
}

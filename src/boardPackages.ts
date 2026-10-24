// Board packages, profiles and scripts (docs/DESIGN.md "Board packages"): one firmware image per chip, and the
// board's pin map sent to it as data. The device layer lists the files allowed extensions offer (board_files) and
// turns a choice into the board's requests (board_setup, core/src/boardpkg.rs); this file holds the dropdowns'
// choices, the words, and the sending of those requests one by one.

/** The capability firmware lists in info.capabilities when it takes board packages. */
export const CAPABILITY = 'board_package';
/** The preset every generic image has built in when nothing else says which (core DEFAULT_PRESETS). */
export const DEFAULT_PRESET = { id: 'proptroller', name: 'Proptroller board' };
/** Why the board package choice is not offered for a board whose firmware has its board built in. */
export const NO_PACKAGES = 'The firmware on this board has its board built in, so it takes no board package. Update it to the generic firmware to choose one.';
/** Why the choice is not offered for a firmware image of an extension. */
export const IMAGE_HAS_ITS_BOARD = 'This firmware has its board built in, so it takes no board package, profile or script here.';
export const RESTART_TITLE = 'Restart now to use the new board package?';

export const takesPackages = (info: any): boolean => Array.isArray(info?.capabilities) && info.capabilities.includes(CAPABILITY);

export interface PluginRef { id: string; name: string }
/** One file an extension offers (board_files). */
export interface BoardFile { plugin: PluginRef; file: string; name: string; id?: string; mcu?: string | null; base?: string | null; error?: string }
export interface BoardFiles { packages: BoardFile[]; profiles: BoardFile[]; scripts: BoardFile[] }
export const NO_FILES: BoardFiles = { packages: [], profiles: [], scripts: [] };
/** get_board's answer. */
export interface BoardAnswer {
  kind: 'board';
  mcu: string;
  running: { id: string; name: string; source: 'built-in' | 'stored' | 'none'; problem?: string };
  stored?: { id: string; name: string; pending: boolean };
  presets: { id: string; name: string }[];
}

export interface Choice { value: string; name: string; note: string; disabled: boolean }
export const KEEP = 'keep';
export const NONE = 'none';
export const FORGET = 'forget';
const fileValue = (f: BoardFile) => `file:${f.plugin.id}:${f.file}`;

/** Whether a package made for chip `pkg` (esp32-devkit, pico) goes on a board whose info.mcu is `board`; a package
 * that names no chip (one on a `base`) goes on any. The board checks the rest. */
export function chipFits(pkg: string | null | undefined, board: string | undefined): boolean {
  if (!pkg || !board) return true;
  if (pkg === 'pico') return board.startsWith('pico');
  return pkg === board;
}
const chipWords = (mcu: string) => (mcu.startsWith('pico') ? 'a Raspberry Pi Pico board' : mcu.startsWith('esp32') ? 'an ESP32 board' : `a ${mcu} board`);

const fromExtension = (f: BoardFile) => `From the extension “${f.plugin.name}”`;

/** The board package dropdown. `board`: the board's get_board answer (a connected board); without it (a new board
 * over USB) the presets are `presets` (from the release, else the Proptroller board) and nothing is kept. `mcu`:
 * the board's chip, so a package for another chip cannot be picked. */
export function packageChoices(o: { board?: BoardAnswer | null; presets?: { id: string; name: string }[]; files: BoardFiles; mcu?: string }): Choice[] {
  const out: Choice[] = [];
  const b = o.board;
  if (b) {
    const pending = b.stored?.pending ? ` (${b.stored.name} is stored and starts at the next restart)` : '';
    const problem = b.running.problem ? `: ${b.running.problem}` : '';
    out.push({ value: KEEP, name: `Keep ${b.running.source === 'none' ? 'no board package' : b.running.name}`, note: `On the board now${problem}${pending}`, disabled: false });
  }
  const presets = b ? b.presets : (o.presets?.length ? o.presets : [DEFAULT_PRESET]);
  for (const p of presets) out.push({ value: `preset:${p.id}`, name: `${p.name} (built in)`, note: 'Built into the firmware', disabled: false });
  for (const f of o.files.packages) {
    const fits = chipFits(f.mcu, o.mcu || b?.mcu);
    const note = f.error ? `Cannot be used: ${f.error}` : !fits ? `Made for ${chipWords(String(f.mcu))}` : fromExtension(f);
    out.push({ value: fileValue(f), name: f.name || f.file, note, disabled: !!f.error || !fits });
  }
  if (b?.stored) out.push({ value: FORGET, name: 'Forget the stored board package', note: `${b.stored.name}: the board goes back to its built-in one`, disabled: false });
  return out;
}

/** A profile or script dropdown: "none (keep the board's)" first. */
export function fileChoices(files: BoardFile[]): Choice[] {
  return [{ value: NONE, name: 'None (keep the board’s)', note: '', disabled: false },
    ...files.map((f) => ({ value: fileValue(f), name: f.name || f.file, note: f.error ? `Cannot be used: ${f.error}` : fromExtension(f), disabled: !!f.error }))];
}

/** board_setup's `package` for a choice: null keeps the board's. */
export function packageArg(value: string, files: BoardFiles): null | { preset: string } | { plugin: string; file: string } | { forget: true } {
  if (!value || value === KEEP) return null;
  if (value === FORGET) return { forget: true };
  if (value.startsWith('preset:')) return { preset: value.slice('preset:'.length) };
  const f = files.packages.find((x) => fileValue(x) === value);
  return f ? { plugin: f.plugin.id, file: f.file } : null;
}

/** board_setup's `profile` / `script` for a choice: undefined leaves the board's. */
export function fileArg(value: string, files: BoardFile[]): { plugin: string; file: string } | undefined {
  const f = files.find((x) => fileValue(x) === value);
  return f ? { plugin: f.plugin.id, file: f.file } : undefined;
}

/** The name of a choice, for the confirmations. */
export const choiceName = (choices: Choice[], value: string) => choices.find((c) => c.value === value)?.name || '';

/** What each request is, for the progress line and for a refusal. */
function what(op: string): { doing: string; thing: string } {
  if (op === 'set_board') return { doing: 'Sending the board package…', thing: 'the board package' };
  if (op === 'set_profile') return { doing: 'Sending the profile…', thing: 'the profile' };
  if (op === 'set_script') return { doing: 'Sending the script…', thing: 'the script' };
  if (op === 'reboot') return { doing: 'Restarting the board…', thing: 'the restart' };
  return { doing: `Sending ${op}…`, thing: op };
}

export interface SetupResult { warnings: string[]; name?: string }
/** A refusal part way: what the board had already taken (`sent`: their ops), so a stored board package still
 * gets its restart question. */
export class SetupError extends Error {
  constructor(message: string, public sent: string[], public result: SetupResult) { super(message); }
}

/** Sends board_setup's requests one by one (`send`: the store's change, with the page password), stopping at the
 * first the board refuses: its own words, as it said them. A script the board checked and did not take (its
 * check is not ok) counts as refused too. Returns the board's warnings and the new package's name. */
export async function sendSetup(send: (req: any) => Promise<any>, requests: any[], onStep?: (doing: string) => void): Promise<SetupResult> {
  const out: SetupResult = { warnings: [] };
  const sent: string[] = [];
  for (const req of requests) {
    const w = what(req.op);
    onStep?.(w.doing);
    const r = await send(req);
    if (!r?.ok) throw new SetupError(`The board did not take ${w.thing}: ${r?.error?.message || 'it gave no reason'}`, sent, out);
    const res = r.result || {};
    if (req.op === 'set_script' && res.ok === false) {
      throw new SetupError(`The board did not take ${w.thing}: ${res.errors?.[0]?.message || 'it has problems'}`, sent, out);
    }
    sent.push(req.op);
    if (req.op === 'set_board') {
      out.name = res.name;
      for (const x of res.warnings || []) out.warnings.push(String(x));
    }
    if (req.op === 'set_script') for (const x of res.warnings || []) out.warnings.push(String(x?.message ?? x));
  }
  return out;
}

/** The question before the restart that starts the new board package. */
export function restartWords(board: string, pkg?: string) {
  return {
    title: RESTART_TITLE,
    text: `${board} has ${pkg ? `“${pkg}”` : 'the new board package'} stored but keeps using its old pins until it restarts. It is gone for a few seconds, then starts with the new board package. You can also restart it later.`,
    yes: 'Restart now',
  };
}

/** The presets a release image says it has built in (`presets`: ids or {id, name}), else the Proptroller board
 * (core boardpkg::presets_of). */
export function releasePresets(img: any): { id: string; name: string }[] {
  if (!Array.isArray(img?.presets)) return [DEFAULT_PRESET];
  return img.presets.flatMap((p: any) => (typeof p === 'string' ? [{ id: p, name: p }] : typeof p?.id === 'string' ? [{ id: p.id, name: typeof p.name === 'string' ? p.name : p.id }] : []));
}

/** A package choice that is a file (it can go on with a USB install, in the board's file system). */
export const writesImage = (value: string) => value.startsWith('file:');

/** How long Studio waits for a board to answer again after its restart, and how often it asks. */
export const BACK_WAIT_MS = 60_000;
export const BACK_ASK_EVERY_MS = 1000;

/** Waits until the board answers again after its restart (`info`), then sends `requests` (board_setup's
 * `after_restart`: the profile and script, which the package's defaults applied at that boot would otherwise
 * replace). False when it did not come back in time. */
export async function sendWhenBack(send: (req: any) => Promise<any>, requests: any[], onStep?: (doing: string) => void, waitMs = BACK_WAIT_MS, everyMs = BACK_ASK_EVERY_MS): Promise<boolean> {
  if (!requests.length) return true;
  onStep?.('Waiting for the board to start again…');
  const until = Date.now() + waitMs;
  for (;;) {
    const r = await send({ op: 'info' }).catch(() => null);
    if (r?.ok) break;
    if (Date.now() >= until) return false;
    await new Promise((ok) => setTimeout(ok, everyMs));
  }
  await sendSetup(send, requests, onStep);
  return true;
}

/** What Studio says when the person keeps the restart for later but a profile or script waits for it. */
export const AFTER_RESTART_LATER = 'The profile and script go on after the restart (the board package\'s own would replace them at that restart): restart it, then send them with “Change board package / setup…”.';

// The SD card for the board's sound player: one sound per folder, sound N is the single file in folder `NN` in the
// card's root, `01/001-rain.mp3`, `02/001-elevator.mp3` … (core/src/sdcard). Scripts play a sound by its number
// (`audio_single = 3` plays folder 03, track 1); these helpers turn card names into "3 · scream" hints and the
// number → file map into text.
import { call } from '../api';

/** The most sounds a card holds: one per folder, folders 01 to 99. */
export const SOUND_FOLDERS_MAX = 99;
/** The biggest drive the card picker offers without "Show all drives" (64 GiB: every card sold as 64 GB). */
export const CARD_MAX_BYTES = 64 * 1024 ** 3;
/** The formats the player plays (MP3 and WAV, 8 to 48 kHz). */
export const AUDIO_EXTS = ['mp3', 'wav'] as const;

export interface SoundNumber { number: number; description: string }
export interface MapRow { number: number; name: string }

const extOf = (name: string) => { const m = /\.([^./\\]+)$/.exec(name); return m ? m[1].toLowerCase() : ''; };

/** A file name's base without its folder and extension: `/x/rain.mp3` -> `rain`. */
export function descriptionOf(path: string) {
  const base = path.split(/[\\/]/).pop() || path;
  return base.replace(/\.[^.]*$/, '') || base;
}

export const isAudio = (name: string) => (AUDIO_EXTS as readonly string[]).includes(extOf(name));

/** `03/001-scream.mp3` -> {number: 3, description: 'scream', ext: 'mp3'}: the number is the folder's (01 to 99),
 * the description what follows the file's leading digits and `-`. */
export function parseCardName(name: string): (SoundNumber & { ext: string }) | null {
  const m = /^(\d{2})[\\/]([^\\/]+)$/.exec(name);
  if (!m || m[1] === '00') return null;
  const stem = m[2].replace(/\.[^.]*$/, '');
  return { number: Number(m[1]), description: stem.replace(/^\d+/, '').replace(/^[-_ .]+/, ''), ext: extOf(name) };
}

/** Card names -> the sounds by number (first file wins a number; hidden Mac `._` files and other formats left out). */
export function soundNumbers(names: string[]): SoundNumber[] {
  const out = new Map<number, SoundNumber>();
  for (const n of names) {
    if ((n.split(/[\\/]/).pop() || '').startsWith('.') || !isAudio(n)) continue;
    const p = parseCardName(n);
    if (p && !out.has(p.number)) out.set(p.number, { number: p.number, description: p.description });
  }
  return [...out.values()].sort((a, b) => a.number - b.number);
}

/** "3 · scream" (or "3" when the file has no description). */
export const soundLabel = (s: SoundNumber) => (s.description ? `${s.number} · ${s.description}` : String(s.number));

/** Reads a card's (or a folder's) `NN/001-desc.ext` names into [{number, description}]. */
export async function readSoundNumbers(folder: string): Promise<SoundNumber[]> {
  return soundNumbers(await call<string[]>('sdcard_names', { folder }));
}

/** The map as plain text: `1  01/001-rain.mp3`, one line each. */
export const mapText = (rows: MapRow[]) => rows.map((r) => `${r.number}  ${r.name}\n`).join('');

const csvCell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The map as CSV: `number,file`. */
export const mapCsv = (rows: MapRow[]) => `number,file\n${rows.map((r) => `${r.number},${csvCell(r.name)}`).join('\n')}${rows.length ? '\n' : ''}`;

/** `sounds.csv` kept with the library (typeahead hints; scripts always use the number): `number,file`, the file
 * being the sound's original name (`1,rain.mp3`). The core's `sounds` command reads it for the editor. */
export function soundsCsv(rows: { number: number; file: string }[]) {
  return `number,file\n${rows.map((r) => `${r.number},${csvCell(r.file)}\n`).join('')}`;
}

function csvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Reads `sounds.csv` (or a saved map, `number,file`) back into sounds by number. */
export function parseSoundsCsv(text: string): SoundNumber[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const head = csvRow(lines[0]).map((h) => h.trim().toLowerCase());
  const has = head.includes('number');
  const iN = has ? head.indexOf('number') : 0;
  const iD = head.indexOf('description');
  const iF = head.indexOf('file');
  const out: SoundNumber[] = [];
  for (const l of has ? lines.slice(1) : lines) {
    const c = csvRow(l);
    const n = Number(c[iN]);
    if (!Number.isInteger(n) || n < 1) continue;
    const description = iD >= 0 ? c[iD] ?? '' : iF >= 0 ? parseCardName(c[iF] ?? '')?.description ?? descriptionOf(c[iF] ?? '') : c[1] ?? '';
    out.push({ number: n, description: description.trim() });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** A card name, as the core makes it (the list's preview): `01/001-rain.mp3` (the file part at most 255
 * characters, FAT's limit for one name). */
export function cardName(n: number, description: string, ext: string) {
  // eslint-disable-next-line no-control-regex
  const d = description.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/, '');
  const room = 255 - 5 - ext.length;
  const cut = [...d].slice(0, room).join('').replace(/[. ]+$/, '');
  const folder = String(n).padStart(2, '0');
  return cut ? `${folder}/001-${cut}.${ext.toLowerCase()}` : `${folder}/001.${ext.toLowerCase()}`;
}

/** Bytes in plain words: "15.9 GB", "3.2 MB". */
export function sizeWords(b: number) {
  if (b >= 1e9) return `${(b / 1e9).toFixed(1)} GB`;
  if (b >= 1e6) return `${(b / 1e6).toFixed(1)} MB`;
  if (b >= 1e3) return `${Math.round(b / 1e3)} kB`;
  return `${b} bytes`;
}

/** Moves item `from` to `to` (drag or the up/down buttons). */
export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length || to < 0 || to >= list.length) return list;
  const next = list.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

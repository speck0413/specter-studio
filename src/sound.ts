// The board's sound player (a DFPlayer Mini on the SOUND terminal), in plain words: which sounds it has, what it
// plays now, and the requests the board's own `sound` op takes. Sound N is the one file in the card's folder NN
// (`03/001-scream.mp3` is sound 3; Studio's SD card tool fills the card), the same sound N as an effect script's
// `audio_single = N`: the player plays folder N, track 1, and loops a folder by itself. The card list (the library's sounds.csv, which the SD card tool keeps)
// gives each number a description.
import type { Board } from './store';

/** The highest sound number (one sound per folder: folders 01 to 99). */
export const SOUND_MAX = 99;

export interface SoundChoice { n: number; name: string }

/** True when the board has a sound player terminal (or says it can play sound). */
export function hasSound(b: Board | undefined): boolean {
  if (!b?.info) return false;
  return (b.info.terminals || []).some((t: any) => String(t.id).toUpperCase() === 'SOUND') || (b.info.capabilities || []).includes('sound');
}

/** A file name from the card list as a beginner reads it: "03/001-door_creak.mp3" or "door_creak.mp3" -> "door creak". */
export function soundName(file: string): string {
  const plain = file.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{2,4}$/i, '').replace(/[_]+/g, ' ').trim();
  return plain.replace(/^0*\d+\s*[-\s]\s*(?=\S)/, '').replace(/-+/g, ' ').trim() || plain;
}

/** The card list's sounds ({file: number}), by number, each once (the first name wins). */
export function soundChoices(sounds: Record<string, number> | undefined): SoundChoice[] {
  const seen = new Map<number, string>();
  for (const [file, n] of Object.entries(sounds || {}).sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
    if (Number.isInteger(n) && n >= 1 && n <= SOUND_MAX && !seen.has(n)) seen.set(n, soundName(file));
  }
  return [...seen].map(([n, name]) => ({ n, name }));
}

/** "sound 3 · scream", or "sound 3" when the list has no name for it. */
export function soundLabel(n: number, sounds?: Record<string, number>): string {
  const c = soundChoices(sounds).find((x) => x.n === n);
  return c ? `sound ${n} · ${c.name}` : `sound ${n}`;
}

export const clampSound = (n: number) => Math.min(SOUND_MAX, Math.max(1, Math.round(n) || 1));
export const clampVolume = (n: number) => Math.min(30, Math.max(0, Math.round(n) || 0));

/** The board's request for each button (its `sound` op). */
export const soundRequest = {
  once: (n: number) => ({ op: 'sound', cmd: 'play_folder', folder: clampSound(n), track: 1 }),
  repeat: (n: number) => ({ op: 'sound', cmd: 'loop_folder', folder: clampSound(n) }),
  stop: () => ({ op: 'sound', cmd: 'stop' }),
  volume: (v: number) => ({ op: 'sound', cmd: 'volume', volume: clampVolume(v) }),
};

export interface SoundNow { online: boolean; playing: boolean; text: string }

// the show source also covers a sound played from Studio or the phone page, so only these two are named
const SOURCE: Record<string, string> = { ambient: 'the background loop', trigger: 'a trigger' };

/** What the sound player does now, from the board's live state (newer `sound` object, older flat fields). The
 * board names the track "/03/001" (sound 3), "/03/ (loop)" (sound 3 on repeat), "/03/005" (another file in that
 * folder), "/mp3/0003" (the mp3 folder) or "card file #3" (the third file in the card's root). */
export function soundNow(state: any, sounds?: Record<string, number>): SoundNow {
  const s = state?.sound || { playing: state?.sound_playing, online: state?.sound_online };
  const online = s.online !== false;
  const playing = !!s.playing;
  if (!online) return { online, playing: false, text: 'The sound player is not answering. Check that it is plugged in and has a memory card.' };
  if (!playing) return { online, playing, text: 'Nothing playing.' };
  const track = String(s.track || '');
  let what = 'a sound';
  let m: RegExpExecArray | null;
  if ((m = /^\/?(\d+)\/\s*\(loop\)/.exec(track))) what = `${soundLabel(Number(m[1]), sounds)} on repeat`;
  else if ((m = /^\/?(\d+)\/(\d+)/.exec(track))) what = Number(m[2]) === 1 ? soundLabel(Number(m[1]), sounds) : `folder ${Number(m[1])}, file ${Number(m[2])}`;
  else if ((m = /mp3\/(\d+)\s*(\(loop\))?/.exec(track))) what = `mp3 folder file ${Number(m[1])}${m[2] ? ' on repeat' : ''}`;
  else if ((m = /#(\d+)/.exec(track))) what = `card file ${Number(m[1])}`;
  const from = s.source && SOURCE[s.source] ? `, started by ${SOURCE[s.source]}` : '';
  return { online, playing, text: `Playing ${what}${from}.` };
}

// "Record effect": what the person did on the live controls (a take) turned into an ordinary effect script.
// The rules live in one place, the firmware's shared module firmware/web/take.js (firmware/docs/RECORD-EFFECT.md),
// which the board's phone page uses too: the same take gives the same script on the phone and in Studio. This
// file only gives that plain JavaScript module its TypeScript types; RecordEffect.tsx captures the take, plays it
// back on the board and saves the text.

// @ts-ignore the firmware's plain ES module has no type declarations; they are written out below
import * as shared from '../../firmware/firmware/web/take.js';

/** A hold of one output, in ms from the start of the take. `cut`: the recorder let go at the maximum on-time
 * while the finger was still down; `heldMs`: how long the finger really stayed down. */
export interface Hold { target: string; start: number; end: number; cut?: boolean; heldMs?: number }
export interface SoundTap { sound: number; at: number }
/** A slider moved (dimmable outputs out1-out4), level in percent. */
export interface LevelChange { target: string; at: number; level: number }
export interface Take { holds: Hold[]; sounds: SoundTap[]; levels?: LevelChange[]; end?: number }

export interface Segment { target: string; start: number; end: number; cut: boolean; heldMs: number }
export interface Step { t: number; level: number; cut?: boolean }

export interface ScriptOptions {
  name: string;
  trigger: string; // trig1, trig2, user1-user3
  /** `<output>_max_on_ms` by lower-case output (rly1 → 5000); 0 or missing = no limit */
  maxOnMs?: Record<string, number>;
  /** names given on the board by lower-case terminal (out1 → lamp) */
  labels?: Record<string, string>;
  step?: number; // ms, default 100
  trimLead?: boolean; // default true
  /** where it was recorded, for the comment at the top ("in Specter Studio") */
  source?: string;
}

/** What the board does when the take plays back: an output's level (percent) or a sound, in time order. */
export type TimelineEntry = { at: number; target: string; level: number; sound?: undefined } | { at: number; sound: number; target?: undefined; level?: undefined };

export interface Plan { steps: Record<string, Step[]>; segments: Segment[]; sounds: SoundTap[]; lengthMs: number; notes: string[] }
export interface ScriptResult extends Plan { text: string; error?: string; effects: number; timeline: TimelineEntry[] }
export interface Merged { text: string; replaced: string[]; clashes: { output: string; effect: string }[] }

/** Board limits (show-script golden README). */
export const LIMITS: { effectLines: number; effects: number; scriptLines: number; bytes: number; nameLen: number } = shared.LIMITS;
/** out1-out4 can dim; relays and contacts are on or off. */
export const dimmable: (target: string) => boolean = shared.dimmable;
export const named: (target: string, labels?: Record<string, string>) => string = shared.named;
/** Seconds as the script writes them: 2, 0.5, 12.3. */
export const seconds: (ms: number) => string = shared.seconds;
/** The take on the step grid, joined, cut to the maximum on-times and moved to start at 0 (with trimLead). */
export const plan: (take: Take, o?: Omit<ScriptOptions, 'name' | 'trigger'>) => Plan = shared.plan;
export const takeToScript: (take: Take, o: ScriptOptions) => ScriptResult = shared.takeToScript;
/** A name from what was recorded: "lamp and siren", "OUT1 and RLY1". */
export const suggestName: (take: Take, labels?: Record<string, string>) => string = shared.suggestName;
/** Two takes as one (an "add more on top" pass over the earlier ones). */
export const mergeTakes: (a: Take, b: Take) => Take = shared.mergeTakes;
/** The effects a recorded effect named `name` replaces in a script (that name and its split parts). */
export const replacedBy: (text: string, name: string) => string[] = shared.replacedBy;
/** Put a recorded script into the stored one: same-named effects replaced in place, else added at the end; the
 * rest stays exactly as it was. `clashes`: outputs a kept effect already sets (the board would refuse it). */
export const mergeScript: (stored: string, recorded: string, name: string, names?: Record<string, string>) => Merged = shared.mergeScript;

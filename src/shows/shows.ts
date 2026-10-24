// Shows on the board (PROTOCOL.md "Shows"), the pure part: links ("on while held" / "on for N seconds when
// pressed"), the show editor's round trip and the checks that tell an older firmware that dropped a field.
// The board keeps the shows; Studio reads them, writes them back whole and never assumes show 1 exists.

/** The lowest show id not in use (ids start at 1). */
export function lowestFreeId(ids: number[]): number {
  const used = new Set(ids);
  let id = 1;
  while (used.has(id)) id++;
  return id;
}

export type LinkMode = 'held' | 'pulse';
export interface LinkSpec { id: number; input: string; outputs: string[]; mode: LinkMode; seconds: number }

export function linkName(input: string, outputs: string[]): string {
  return `Link: ${input.toUpperCase()} -> ${outputs.map((o) => o.toUpperCase()).join(', ')}`;
}

/** A link is a normal show: "held" turns the outputs on while the input is held (at most `seconds`), "pulse"
 * turns them on for `seconds` on each press. */
export function linkShow(s: LinkSpec, enabled = true): any {
  const ms = Math.round(s.seconds * 1000);
  const trigger: any = { on: 'input', input: s.input.toUpperCase() };
  if (s.mode === 'held') trigger.until_release = true;
  return {
    id: s.id,
    name: linkName(s.input, s.outputs),
    enabled,
    triggers: [trigger],
    tracks: s.outputs.map((o) => ({ target: o.toUpperCase(), cues: [s.mode === 'held' ? { at: 0, do: 'on' } : { at: 0, do: 'pulse', ms }] })),
    length_ms: ms,
  };
}

/** The indexes of a show's input triggers (the only ones that can be "while held"). */
export function inputTriggers(data: any): number[] {
  return (data?.triggers || []).map((t: any, i: number) => (t?.on === 'input' ? i : -1)).filter((i: number) => i >= 0);
}

export interface ShowEdit { name: string; enabled: boolean; held: Record<number, boolean> }

export function editOf(data: any): ShowEdit {
  const held: Record<number, boolean> = {};
  for (const i of inputTriggers(data)) held[i] = data.triggers[i].until_release === true;
  return { name: data?.name ?? '', enabled: data?.enabled !== false, held };
}

/** The board's own show data with only the edited fields changed: everything else goes back as it came.
 * "While held" off removes the key (the firmware leaves it out when false). */
export function applyEdit(data: any, e: ShowEdit): any {
  const out = JSON.parse(JSON.stringify(data));
  out.name = e.name;
  out.enabled = e.enabled;
  for (const i of inputTriggers(out)) {
    if (!(i in e.held)) continue;
    if (e.held[i]) out.triggers[i].until_release = true;
    else delete out.triggers[i].until_release;
  }
  return out;
}

/** True when every "while held" the request asked for is still there in what the board gives back (an older
 * firmware takes the show but drops `until_release`, which would leave a held link on for its whole length). */
export function heldKept(sent: any, got: any): boolean {
  return (sent?.triggers || []).every((t: any, i: number) => t?.until_release !== true || got?.triggers?.[i]?.until_release === true);
}

export const wantsHeld = (data: any) => (data?.triggers || []).some((t: any) => t?.until_release === true);

/** The terminals a show drives (its tracks' targets). */
export const showTargets = (data: any): string[] => [...new Set<string>((data?.tracks || []).map((t: any) => String(t.target).toUpperCase()))];

/** What the effect script drives, as show targets (OUT1, RLY1, PIXEL, SOUND, ...). */
export function scriptTargets(text: string): string[] {
  const out = new Set<string>();
  const code = text.split('\n').map((l) => l.replace(/#.*/, '')).join('\n');
  for (const m of code.matchAll(/\b(out\d|rly\d|cc\d|dmx\d*|pixels?)\b/gi)) out.add(m[1].toUpperCase().replace(/^PIXELS$/, 'PIXEL'));
  if (/\b(audio_\w+|sound\w*)\b/i.test(code)) out.add('SOUND');
  return [...out];
}

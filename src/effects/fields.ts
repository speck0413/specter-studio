// The blocks' fields that pick from a list instead of typing (SHOW-SCRIPT.md SS-E2): inputs, outputs, levels,
// sounds, times and counts. Every field keeps the text exactly as the line wrote it (any case, a name given to the
// terminal, a value the lists do not know): the menu is limited, the value never is, so text -> blocks -> text stays
// the identical text and a name the board does not have is shown, marked, never dropped.
import * as Blockly from 'blockly';
import { dimsId, findTerm, getTerms, outputDims, shown, Term } from './terms';

type Option = [string, string];
type ChoiceKind = 'input' | 'output' | 'dimmable' | 'level' | 'volume' | 'sound' | 'loop';
type PopupKind = 'time' | 'runs';

// menu items that open a small editor instead of being a value
const LEVEL = '\u0000level';
const DMX = '\u0000dmx';
const NUMBER = '\u0000number';

const unknownNote = (what: 'terminal' | 'sound' | 'setting') => {
  const t = getTerms();
  if (what === 'sound') return 'not in the sound list';
  return t.fromBoard ? 'not on this board' : 'unknown name';
};
const percentOf = (v: string): number | null => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(v);
  return m ? Number(m[1]) : null;
};
const LEVEL_WORDS = /^\s*(on|off|true|false|\d+(\.\d+)?\s*%)\s*$/i;

// ---------------------------------------------------------------- the small editor under a field

const POPUP_CSS = 'display:flex;flex-direction:column;gap:8px;padding:8px 10px;font:14px system-ui,sans-serif;color:#202124;min-width:200px';
const ROW_CSS = 'display:flex;align-items:center;gap:6px';
const INPUT_CSS = 'font:inherit;padding:2px 4px;border:1px solid #9aa0a6;border-radius:4px;background:#fff;color:#202124';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, any> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') e.setAttribute('style', v);
    else if (k.startsWith('aria-') || k.startsWith('data-')) e.setAttribute(k, String(v));
    else (e as any)[k] = v;
  }
  for (const k of kids) e.append(k);
  return e;
}

/** Opens a small editor under the field: `build` fills it and returns what gets the focus. Enter and Escape close it. */
function popup(field: Blockly.Field<any>, title: string, build: (box: HTMLElement) => HTMLElement) {
  const D = Blockly.DropDownDiv;
  D.hideWithoutAnimation();
  D.clearContent();
  const close = () => D.hideIfOwner(field, true);
  const box = el('div', { style: POPUP_CSS, role: 'group', 'aria-label': title, className: 'ps-popup' });
  const first = build(box);
  box.append(el('div', { style: ROW_CSS }, el('button', { type: 'button', textContent: 'Done', style: INPUT_CSS + ';cursor:pointer;margin-left:auto', onclick: close })));
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  });
  D.getContentDiv().append(box);
  D.setColour('#ffffff', '#dadce0');
  // closed (Done, Enter, Escape or a click away): the keyboard goes back to the field it came from
  const back = () => { try { Blockly.getFocusManager().focusNode(field as any); } catch { /* the block is gone */ } };
  D.showPositionedByField(field, back, undefined, false);
  setTimeout(() => { first.focus(); if (first instanceof HTMLInputElement) first.select(); }, 0);
}

function numberInput(label: string, value: string, attrs: Record<string, any>, onValue: (v: string) => void) {
  const input = el('input', { type: 'number', value, 'aria-label': label, style: INPUT_CSS + ';width:6em', ...attrs });
  input.addEventListener('input', () => { if (input.value !== '' && input.validity.valid !== false) onValue(input.value); });
  return input;
}

/** The level editor: a slider and a number, 0-100 % in steps of 5 (typing any whole or decimal number works too). */
function levelPopup(field: Blockly.Field<string>) {
  const start = percentOf(field.getValue() || '') ?? 50;
  field.setValue(`${start}%`);
  popup(field, 'Level', (box) => {
    const slider = el('input', { type: 'range', min: '0', max: '100', step: '5', value: String(start), 'aria-label': 'Level in percent', style: 'flex:1;min-width:120px' });
    const num = numberInput('Level in percent, as a number', String(start), { min: '0', max: '100', step: '5' }, (v) => { slider.value = v; field.setValue(`${Number(v)}%`); });
    slider.addEventListener('input', () => { num.value = slider.value; field.setValue(`${slider.value}%`); });
    box.append(el('div', { style: ROW_CSS }, slider, num, el('span', { textContent: '%' })));
    return slider;
  });
}

function countPopup(field: Blockly.Field<string>, title: string, label: string, attrs: Record<string, any>, value: string, write: (n: string) => string) {
  popup(field, title, (box) => {
    const num = numberInput(label, value, attrs, (v) => field.setValue(write(v)));
    box.append(el('label', { style: ROW_CSS }, el('span', { textContent: label }), num));
    if (!/^\d+$/.test(value)) field.setValue(write(value || '1'));
    return num;
  });
}

// ---------------------------------------------------------------- times

const UNIT_OF: Record<string, 's' | 'ms' | 'min'> = {
  ms: 'ms', millisecond: 'ms', milliseconds: 'ms', s: 's', sec: 's', secs: 's', second: 's', seconds: 's', min: 'min', mins: 'min', minute: 'min', minutes: 'min',
};
/** a written time read as a number and unit, or a setting's name, or null for text the editor does not know */
export function readTime(v: string): { n: string; unit: 's' | 'ms' | 'min' } | { setting: string } | null {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*([a-z]*)\s*$/i.exec(v);
  if (m && (m[2] === '' || UNIT_OF[m[2].toLowerCase()])) return { n: m[1].replace(/\.$/, ''), unit: m[2] ? UNIT_OF[m[2].toLowerCase()] : 's' };
  if (/^[A-Za-z][A-Za-z0-9_]*$/.test(v.trim())) return { setting: v.trim() };
  return null;
}
/** a time as a line writes it: seconds as a bare number, else with its unit */
export const writeTime = (n: string, unit: 's' | 'ms' | 'min') => (unit === 's' ? n : `${n} ${unit}`);

function timePopup(field: Blockly.Field<string>) {
  const t = getTerms();
  const r = readTime(field.getValue() || '');
  const settings = t.timeSettings;
  popup(field, 'Time', (box) => {
    let n = r && 'n' in r ? r.n : '1';
    let unit: string = r && 'unit' in r ? r.unit : r && 'setting' in r ? 'setting' : 's';
    let setting = r && 'setting' in r ? r.setting : settings[0]?.id || '';
    const num = numberInput('How long', n, { min: '0', step: 'any' }, (v) => { n = v; write(); });
    const units = el('select', { 'aria-label': 'Unit', style: INPUT_CSS });
    for (const [v, l] of [['s', 'seconds'], ['ms', 'milliseconds'], ['min', 'minutes'], ['setting', 'a setting…']]) units.append(el('option', { value: v, textContent: l }));
    units.value = unit;
    const pick = el('select', { 'aria-label': 'Setting', style: INPUT_CSS });
    const known = settings.some((s) => s.id.toLowerCase() === setting.toLowerCase());
    if (setting && !known) pick.append(el('option', { value: setting, textContent: `${setting} (${unknownNote('setting')})` }));
    for (const s of settings) pick.append(el('option', { value: s.id, textContent: s.name ? `${s.id} (${s.name})` : s.id }));
    pick.value = setting;
    const settingRow = el('label', { style: ROW_CSS }, el('span', { textContent: 'Setting' }), pick);
    const show = () => { num.hidden = unit === 'setting'; settingRow.hidden = unit !== 'setting'; };
    const write = () => field.setValue(unit === 'setting' ? setting : writeTime(n, unit as 's' | 'ms' | 'min'));
    units.addEventListener('change', () => { unit = units.value; show(); write(); });
    pick.addEventListener('change', () => { setting = pick.value; write(); });
    box.append(el('div', { style: ROW_CSS }, num, units), settingRow);
    show();
    return unit === 'setting' ? units : num;
  });
}

function runsPopup(field: Blockly.Field<string>) {
  const t = getTerms();
  const v = (field.getValue() || '').trim();
  const isNum = /^\d+$/.test(v);
  popup(field, 'How many runs', (box) => {
    let mode = isNum || !v ? 'number' : 'setting';
    let n = isNum ? v : '3';
    let setting = isNum || !v ? t.countSettings[0]?.id || '' : v;
    const num = numberInput('Runs', n, { min: '1', step: '1' }, (x) => { n = x; write(); });
    const modes = el('select', { 'aria-label': 'A number or a setting', style: INPUT_CSS });
    modes.append(el('option', { value: 'number', textContent: 'runs' }), el('option', { value: 'setting', textContent: 'a setting…' }));
    modes.value = mode;
    const pick = el('select', { 'aria-label': 'Setting', style: INPUT_CSS });
    if (setting && !t.countSettings.some((s) => s.id.toLowerCase() === setting.toLowerCase())) pick.append(el('option', { value: setting, textContent: `${setting} (${unknownNote('setting')})` }));
    for (const s of t.countSettings) pick.append(el('option', { value: s.id, textContent: s.name ? `${s.id} (${s.name})` : s.id }));
    pick.value = setting;
    const show = () => { num.hidden = mode !== 'number'; pick.hidden = mode === 'number'; };
    const write = () => field.setValue(mode === 'number' ? n : setting);
    modes.addEventListener('change', () => { mode = modes.value; show(); write(); });
    pick.addEventListener('change', () => { setting = pick.value; write(); });
    box.append(el('div', { style: ROW_CSS }, num, pick, modes));
    show();
    return mode === 'number' ? num : modes;
  });
}

// ---------------------------------------------------------------- dropdowns

/** The output a level field's block sets (its TARGET), or '' when there is none. */
const targetOf = (f: Blockly.Field<any>) => {
  const b = f.getSourceBlock();
  return (b && b.getField('TARGET') ? b.getFieldValue('TARGET') : '') || '';
};

/** the menu for a kind of choice, before the field's own value is added */
function baseOptions(kind: ChoiceKind, field: Blockly.Field<any>): Option[] {
  const t = getTerms();
  const terminal = (x: Term): Option => [shown(x), x.id];
  switch (kind) {
    case 'input': return t.inputs.map(terminal);
    case 'output': return [...t.outputs.map(terminal), ['DMX channel…', DMX]];
    case 'dimmable': return [...t.outputs.filter((o) => o.dims).map(terminal), ['DMX channel…', DMX]];
    case 'level': {
      const target = targetOf(field);
      return outputDims(t, target) ? [['on', 'on'], ['off', 'off'], ['level…', LEVEL]] : [['on', 'on'], ['off', 'off']];
    }
    case 'volume': return [['100%', '100%'], ['off (silent)', 'off'], ['level…', LEVEL]];
    case 'sound': return [...t.sounds.map(soundOption), ['another number…', NUMBER]];
    case 'loop': return [...t.sounds.map(soundOption), ['off (no background sound)', 'off'], ['another number…', NUMBER]];
  }
}

const soundOption = (s: { n: number; description: string }): Option => [s.description ? `${s.n} · ${s.description}` : String(s.n), String(s.n)];

/** The menu with the field's value in it: a known value written another way (`TRIG1`, `bell`) takes that entry's place. */
export function choiceOptions(kind: ChoiceKind, field: Blockly.Field<any>, value: string): Option[] {
  const base = baseOptions(kind, field);
  const t = getTerms();
  if (base.some(([, v]) => v === value)) return base;
  if (kind === 'input' || kind === 'output' || kind === 'dimmable') {
    const list = kind === 'input' ? t.inputs : t.outputs;
    const hit = findTerm(list, value);
    if (hit) {
      const i = base.findIndex(([, v]) => v === hit.id);
      if (i >= 0) { const copy = base.slice(); copy[i] = [base[i][0], value]; return copy; }
      // a known terminal the menu leaves out (a relay in a fade): shown as it is
      return [[shown(hit), value], ...base];
    }
    if (/^\s*dmx\s*\d+\s*$/i.test(value)) return [[value.trim(), value], ...base];
    return [[value.trim() ? `${value.trim()} (${unknownNote('terminal')})` : '…', value], ...base];
  }
  if (kind === 'level' || kind === 'volume') {
    if (LEVEL_WORDS.test(value)) {
      const i = base.findIndex(([, v]) => v === value.trim().toLowerCase());
      if (i >= 0) { const copy = base.slice(); copy[i] = [base[i][0], value]; return copy; }
      return [[value.trim(), value], ...base];
    }
    return [[value.trim() ? `${value.trim()} (not a level)` : '…', value], ...base];
  }
  // sound: a number (written another way, `02`, it takes its entry's place); a number the list does not have is
  // marked when a list is known, anything else is marked as not a number
  if (kind === 'loop' && /^\s*(off|false|"")\s*$/i.test(value)) return [[value.trim(), value], ...base.filter(([, v]) => v !== 'off')];
  const num = /^\s*(\d+)\s*$/.exec(value);
  if (num) {
    const i = base.findIndex(([, v]) => v === String(Number(num[1])));
    if (i >= 0) { const copy = base.slice(); copy[i] = [base[i][0], value]; return copy; }
    return [[t.sounds.length ? `${value.trim()} (${unknownNote('sound')})` : value.trim(), value], ...base];
  }
  return [[value.trim() ? `${value.trim()} (not a sound number)` : '…', value], ...base];
}

export class ChoiceField extends Blockly.FieldDropdown {
  kind!: ChoiceKind;
  constructor(kind: ChoiceKind, value: string) {
    super(Blockly.Field.SKIP_SETUP);
    this.kind = kind;
    this.setOptions(() => choiceOptions(this.kind, this, this.getValue() ?? ''));
    this.setValue(value);
  }
  static fromJson(o: any) { return new ChoiceField(o.kind, o.text ?? ''); }
  getOptions(): any[] { return choiceOptions(this.kind, this, this.getValue() ?? ''); }
  // any text is kept as written; the menu is what is limited
  protected doClassValidation_(v?: string): string | null { return typeof v === 'string' && !v.startsWith('\u0000') ? v : null; }
  protected getText_(): string | null {
    const v = this.getValue() ?? '';
    return choiceOptions(this.kind, this, v).find(([, x]) => x === v)?.[0] ?? v;
  }
  protected showEditor_(e?: MouseEvent) {
    // no sound list: the sound is a number
    if (this.kind === 'sound' && !getTerms().sounds.length) { this.openNumber(); return; }
    super.showEditor_(e);
  }
  protected onItemSelected_(menu: Blockly.Menu, item: Blockly.MenuItem) {
    const v = item.getValue();
    if (v === LEVEL || v === DMX || v === NUMBER) {
      Blockly.DropDownDiv.hideIfOwner(this as any, true);
      setTimeout(() => (v === LEVEL ? levelPopup(this as any) : this.openNumber(v === DMX)), 0);
      return;
    }
    super.onItemSelected_(menu, item);
  }
  private openNumber(dmx = false) {
    if (dmx) {
      const m = /dmx\s*(\d+)/i.exec(this.getValue() || '');
      countPopup(this, 'DMX channel', 'DMX channel', { min: '1', max: '512', step: '1' }, m ? m[1] : '1', (n) => `dmx${n}`);
    } else {
      const v = (this.getValue() || '').trim();
      countPopup(this, 'Sound number', 'Sound number', { min: '1', step: '1' }, /^\d+$/.test(v) ? v : '1', (n) => n);
    }
  }
}

/** A time (`2`, `200 ms`, `3 min`, a setting) or a count of runs: opens a small editor with a number and a unit. */
export class PopupField extends Blockly.Field<string> {
  kind!: PopupKind;
  SERIALIZABLE = true;
  constructor(kind: PopupKind, value: string) {
    super(value);
    this.kind = kind;
  }
  static fromJson(o: any) { return new PopupField(o.kind, o.text ?? ''); }
  protected doClassValidation_(v?: string): string | null { return typeof v === 'string' ? v : null; }
  protected getText_(): string | null {
    const v = (this.getValue() ?? '').trim();
    const t = getTerms();
    if (this.kind === 'runs') {
      if (/^\d+$/.test(v) || !v) return `${v || '…'} ▾`;
      return `${v}${findTerm(t.countSettings, v) ? '' : ` (${unknownNote('setting')})`} ▾`;
    }
    const r = readTime(v);
    if (!r) return `${v || '…'} ▾`;
    if ('n' in r) return `${/^\d/.test(v) && !/[a-z]/i.test(v) ? `${v} s` : v} ▾`;
    return `${v}${findTerm(t.timeSettings, v) ? '' : ` (${unknownNote('setting')})`} ▾`;
  }
  protected showEditor_() {
    if (this.kind === 'runs') runsPopup(this); else timePopup(this);
  }
}

let registered = false;
export function registerFields() {
  if (registered) return;
  registered = true;
  Blockly.fieldRegistry.register('field_ps_choice', ChoiceField as any);
  Blockly.fieldRegistry.register('field_ps_popup', PopupField as any);
}

// ---------------------------------------------------------------- a relay never keeps a percentage

const noted = new WeakSet<Blockly.Block>();
/** The note shown on a block whose level was changed because its output became a relay or contact. */
export const relayNote = (target: string, was: string, now: string) => `${target.trim()} is on or off only, so ${was.trim()} became ${now}.`;

/**
 * A workspace change listener: when a set block's output changes to one that does not dim, a percentage becomes on
 * (above 0) or off, with a note on the block. Loading text never fires it (events are off then), so the text a
 * script was written with stays as it is.
 */
export function levelFollowsTarget(ws: Blockly.Workspace) {
  return (e: Blockly.Events.Abstract) => {
    if (e.type !== Blockly.Events.BLOCK_CHANGE) return;
    const c = e as Blockly.Events.BlockChange;
    if (c.element !== 'field') return;
    const b = c.blockId ? ws.getBlockById(c.blockId) : null;
    if (!b || b.type !== 'ps_set') return;
    const setNote = (s: string | null) => {
      if (typeof (b as any).setWarningText === 'function') (b as any).setWarningText(s);
      (b as any).levelNote = s;
      if (s) noted.add(b); else noted.delete(b);
    };
    if (c.name === 'TARGET') {
      const target = String(c.newValue ?? '');
      const level = b.getFieldValue('LEVEL') || '';
      const pc = percentOf(level);
      if (pc !== null && !outputDims(getTerms(), target)) {
        const now = pc > 0 ? 'on' : 'off';
        Blockly.Events.setGroup(c.group || true);
        try { b.setFieldValue(now, 'LEVEL'); } finally { Blockly.Events.setGroup(false); }
        setNote(relayNote(target, level, now));
        return;
      }
    }
    if (noted.has(b) && !(c.name === 'LEVEL' && /^(on|off)$/.test(String(c.newValue)) && percentOf(String(c.oldValue ?? '')) !== null)) setNote(null);
  };
}

export { dimsId };

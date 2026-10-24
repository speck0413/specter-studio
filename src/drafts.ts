// Unsaved effect edits, kept while you go to another page or another effect, so leaving the editor never loses
// work. In a browser, closing the tab with unsaved edits asks first (the beforeunload prompt below); the desktop
// window asks in Studio's own dialog instead (CloseGuard), since a webview's beforeunload can block closing
// without asking. Every change is also kept on disk a moment later (hotexit.ts), so a crash or a kill loses
// nothing: the next start offers it again.
import { inTauri } from './api';

/** An unsaved edit: its text and what it started from (`base`, the saved text; or `baseHash` for an edit
 * restored from last time, see hotexit.ts). */
export interface Draft { text: string; base?: string; baseHash?: string }

const drafts = new Map<string, Draft>();

// ---------------------------------------------------------------- change listeners (hotexit.ts keeps the disk copy)
const listeners = new Set<() => void>();
/** Called after every change to the unsaved edits or settings. */
export function onDraftsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function changed() {
  listeners.forEach((l) => l());
}

export function getDraft(name: string): string | undefined {
  return drafts.get(name)?.text;
}

export function getDraftEntry(name: string): Draft | undefined {
  return drafts.get(name);
}

/** Remember `text` for `name` when it differs from what is saved; forget it when it is the same. */
export function setDraft(name: string, text: string, saved: string) {
  const old = drafts.get(name);
  if (text === saved) {
    if (!drafts.delete(name)) return;
  } else {
    if (old && old.text === text && old.base === saved) return;
    drafts.set(name, { text, base: saved });
  }
  changed();
}

/** A draft as it was restored (hotexit.ts): kept as is until it is edited, saved or dropped. */
export function putDraft(name: string, d: Draft) {
  drafts.set(name, d);
  changed();
}

export function dropDraft(name: string) {
  if (drafts.delete(name)) changed();
}

export function moveDraft(from: string, to: string) {
  const t = drafts.get(from);
  drafts.delete(from);
  if (t !== undefined) {
    drafts.set(to, t);
    changed();
  }
}

export function unsavedNames(): string[] {
  return [...drafts.keys()];
}

export function allDrafts(): [string, Draft][] {
  return [...drafts.entries()];
}

/** Forgets every unsaved effect edit, board setting and sketch ("Close without saving"). */
export function dropAll() {
  drafts.clear();
  unsavedSettings.clear();
  sketchDrafts.clear();
  boardScriptDrafts.clear();
  changed();
}

/** A Map that tells the listeners about every change. */
class WatchedMap<K, V> extends Map<K, V> {
  set(k: K, v: V) { super.set(k, v); changed(); return this; }
  delete(k: K) { const r = super.delete(k); if (r) changed(); return r; }
  clear() { const had = this.size > 0; super.clear(); if (had) changed(); }
}

/** Board settings typed but not saved yet, per board key (SettingsPanel keeps them here). */
export const unsavedSettings: Map<string, Record<string, any>> = new WatchedMap();

/** What SettingsPanel knows about a board's settings, so its unsaved ones can be kept on disk: the board's id
 * (keys of practice boards change every start), its name, the values the edits started from, and which settings
 * are secrets (never written). */
export interface SettingsMeta { id?: string; name?: string; base: Record<string, any>; secrets: string[] }
export const settingsMeta = new Map<string, SettingsMeta>();

export function unsavedSettingsBoards(): string[] {
  return [...unsavedSettings.keys()];
}

/** A firmware sketch of your own with unsaved edits (FirmwareEditor), by project name: the text, the blocks (in
 * blocks mode) and what is saved, so going to another page and back, or closing, never loses it. */
export interface SketchDraft { text: string; blocks: unknown | null; saved: string; blocksSaved: string }
export const sketchDrafts: Map<string, SketchDraft> = new WatchedMap();
export function unsavedSketches(): string[] {
  return [...sketchDrafts.keys()];
}

/** A board's effect script edited on its page but neither sent nor saved yet, by board key: the text and the
 * board's text it started from. Kept while Studio runs (another tab, another page); not written to disk. */
export interface BoardScriptDraft { text: string; base: string }
export const boardScriptDrafts: Map<string, BoardScriptDraft> = new WatchedMap();
export function unsavedBoardScripts(): string[] {
  return [...boardScriptDrafts.keys()];
}

/** Work in progress that closing would cut off (a firmware update, an upload over USB, sending an effect), by an
 * id, in plain words. Closing asks first while any is running. */
export const inFlight: Map<string, string> = new WatchedMap();

// Closing the desktop window with unsaved edits asks in Studio's own dialog (components/CloseGuard.tsx).
/** The question to ask before closing, or null when nothing is unsaved. */
export function closeQuestion(effects: string[], boards: string[], sketches: string[] = [], busy: string[] = [], boardScripts: string[] = []): { title: string; text: string } | null {
  if (busy.length) {
    const unsaved = closeQuestion(effects, boards, sketches, [], boardScripts);
    return {
      title: 'Close while Studio is still working?',
      text: `Studio is still busy: ${busy.join('; ')}. Closing now stops it half way${/firmware|USB/i.test(busy.join(' ')) ? ', which can leave a board without working firmware until it is updated again' : ''}.${unsaved ? ' ' + unsaved.text : ''}`,
    };
  }
  if (!effects.length && !boards.length && !sketches.length && !boardScripts.length) return null;
  const parts: string[] = [];
  if (effects.length) parts.push(`${effects.length === 1 ? 'the effect' : 'the effects'} ${effects.map((n) => `“${n}”`).join(', ')}`);
  if (sketches.length) parts.push(`${sketches.length === 1 ? 'the firmware' : 'the firmwares'} ${sketches.map((n) => `“${n}”`).join(', ')}`);
  if (boards.length) parts.push(`the settings of ${boards.join(', ')}`);
  if (boardScripts.length) parts.push(`the effect script on ${boardScripts.join(', ')}`);
  return {
    title: 'Close without saving?',
    text: `You changed ${parts.join(' and ')} and did not save. Closing Specter Studio loses those changes.`,
  };
}

/** What happens on a close request: nothing unsaved closes; else ask, and close only on yes. */
export async function onCloseRequest(
  e: { preventDefault: () => void },
  question: { title: string; text: string } | null,
  confirm: (title: string, text: string, yes: string) => Promise<boolean>,
  close: () => Promise<void>,
) {
  if (!question) return;
  e.preventDefault();
  if (await confirm(question.title, question.text, 'Close without saving')) await close();
}

if (typeof window !== 'undefined' && !inTauri) {
  window.addEventListener('beforeunload', (e) => {
    if (drafts.size === 0 && unsavedSettings.size === 0 && sketchDrafts.size === 0 && boardScriptDrafts.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

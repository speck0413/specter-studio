// Hot exit, as in VS Code: unsaved effect edits and typed-but-unsaved board settings are kept on disk a moment
// after every change (the library's `.specter/unsaved.json`, through the device layer: core/src/unsaved.rs), so
// a crash, a kill or the computer shutting down loses nothing. The next start puts them back and lists them in
// one calm note (RestoreNote) with Keep / Discard each; an effect saved elsewhere since then shows both versions
// to pick from. Closing on purpose with "Close without saving" discards them; closing a browser tab keeps them
// (like a crash: the tab cannot tell a reload from a close).
import { call as realCall } from './api';
import { allDrafts, dropAll, dropDraft, getDraft, onDraftsChanged, putDraft, settingsMeta, unsavedSettings } from './drafts';

/** How long after the last change the disk copy is written. */
export const PERSIST_MS = 300;

/** A restored item, until the person keeps or discards it. */
export type Restored =
  | { kind: 'effect'; name: string; text: string; library: string | null; conflict: boolean; missing: boolean }
  | { kind: 'settings'; id: string; name: string; key?: string; edits: Record<string, any>; base: Record<string, any>; board?: string };

/** Board settings restored for a board that is not connected yet, by board id. */
export interface PendingSettings { name: string; key?: string; edits: Record<string, any>; base: Record<string, any> }

type Call = (cmd: string, args?: Record<string, unknown>) => Promise<any>;

/** The whole of Studio's hot exit state: one instance for the app (`hotExit`), fresh ones in tests. */
export class HotExit {
  private call: Call;
  private folder = '';
  private ready = false; // nothing is written before the restore has read what is there
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  private stopped = false;
  restored: Restored[] = [];
  pending = new Map<string, PendingSettings>();
  private subs = new Set<() => void>();
  private compareSubs = new Set<(name: string) => void>();
  version = 0;

  constructor(call: Call = realCall) {
    this.call = call;
    this.dispose = onDraftsChanged(() => { this.prune(); this.schedule(); });
  }

  /** Stops listening (tests). */
  dispose: () => void;

  /** Listens for restored items changing (RestoreNote, EffectEditor). */
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  }
  private notify() {
    this.version++;
    this.subs.forEach((f) => f());
  }

  /** What is written: every unsaved edit and setting, plus restored settings still waiting for their board. */
  snapshot() {
    const effects: Record<string, { text: string; base?: string; base_hash?: string }> = {};
    for (const [name, d] of allDrafts()) effects[name] = d.baseHash !== undefined ? { text: d.text, base_hash: d.baseHash } : { text: d.text, base: d.base ?? '' };
    const settings: Record<string, PendingSettings> = {};
    for (const [id, p] of this.pending) settings[id] = p;
    for (const [key, edits] of unsavedSettings) {
      const m = settingsMeta.get(key);
      const secret = new Set(m?.secrets || []);
      const kept = Object.fromEntries(Object.entries(edits).filter(([k]) => !secret.has(k)));
      if (!Object.keys(kept).length) continue;
      const base = Object.fromEntries(Object.keys(kept).filter((k) => m?.base && k in m.base).map((k) => [k, m!.base[k]]));
      settings[m?.id || key] = { name: m?.name || key, key, edits: kept, base };
    }
    return { effects, settings };
  }

  private schedule() {
    if (!this.ready || this.stopped || !this.folder) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, PERSIST_MS);
  }

  /** Writes the disk copy now (the debounce's end; a tab closing). */
  flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.ready || this.stopped || !this.folder) return this.writing;
    const folder = this.folder;
    const snap = this.snapshot();
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
    this.writing = this.writing.then(() => this.call('unsaved_put', { folder, ...snap, now: stamp })).then(() => {}, () => {});
    return this.writing;
  }

  /** Reads last time's unsaved work for this library and puts it back. Edits made in this session win. */
  restore(folder: string): Promise<Restored[]> {
    // asked twice for the same folder (React runs effects twice in development): one read
    if (this.restoring && this.restoring.folder === folder) return this.restoring.p;
    const p = this.doRestore(folder);
    this.restoring = { folder, p };
    return p;
  }
  private restoring: { folder: string; p: Promise<Restored[]> } | null = null;

  private async doRestore(folder: string): Promise<Restored[]> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.ready = false;
    this.folder = folder;
    this.restored = [];
    this.pending.clear();
    if (!folder) { this.notify(); return []; }
    let read = false;
    try {
      const r = await this.call('unsaved_get', { folder });
      for (const e of r?.effects || []) {
        if (getDraft(e.name) !== undefined) continue;
        // a restored edit keeps the hash it started from, so it stays a conflict until the person picks
        putDraft(e.name, { text: e.text, baseHash: e.base_hash ?? '' });
        this.restored.push({ kind: 'effect', name: e.name, text: e.text, library: e.library ?? null, conflict: !!e.conflict, missing: !!e.missing });
      }
      for (const [id, s] of Object.entries<any>(r?.settings || {})) {
        if (!s?.edits || !Object.keys(s.edits).length) continue;
        this.pending.set(id, { name: s.name || id, key: s.key, edits: s.edits, base: s.base || {} });
        this.restored.push({ kind: 'settings', id, name: s.name || id, key: s.key, edits: s.edits, base: s.base || {} });
      }
      read = true;
    } catch {
      // the disk copy cannot be read: start clean, and write only once there is something new to keep
      this.restored = [];
    }
    this.ready = true;
    this.notify();
    if (read) this.schedule();
    return this.restored;
  }

  /** Restored items that were saved or undone from their own page meanwhile leave the note. */
  private prune() {
    if (!this.ready || !this.restored.length) return;
    const left = this.restored.filter((r) => (r.kind === 'effect' ? getDraft(r.name) !== undefined : !r.board || unsavedSettings.has(r.board)));
    if (left.length !== this.restored.length) { this.restored = left; this.notify(); }
  }

  /** A board connected: settings restored for it (same id, or the same key) become its unsaved settings. */
  boardConnected(key: string, id: string | undefined, name: string | undefined) {
    let moved = false;
    for (const [pid, p] of this.pending) {
      if (pid !== id && p.key !== key && pid !== key) continue;
      this.pending.delete(pid);
      if (!unsavedSettings.has(key)) {
        settingsMeta.set(key, { id: id || pid, name: name || p.name, base: p.base, secrets: settingsMeta.get(key)?.secrets || [] });
        unsavedSettings.set(key, { ...p.edits });
      }
      const item = this.restored.find((r) => r.kind === 'settings' && r.id === pid);
      if (item && item.kind === 'settings') item.board = key;
      moved = true;
    }
    if (moved) { this.notify(); this.schedule(); }
  }

  /** Keep: the item stays as unsaved work (save it from its page); the note forgets it. */
  keep(item: Restored) {
    this.restored = this.restored.filter((r) => r !== item);
    this.notify();
  }

  /** Discard: the restored change is dropped. */
  discard(item: Restored) {
    if (item.kind === 'effect') dropDraft(item.name);
    else {
      this.pending.delete(item.id);
      if (item.board) unsavedSettings.delete(item.board);
    }
    this.restored = this.restored.filter((r) => r !== item);
    this.notify();
    this.schedule();
  }

  /** Conflict, "Keep mine": my version stays unsaved, now counted against the library's current text. */
  keepMine(item: Restored) {
    if (item.kind !== 'effect') return;
    const t = getDraft(item.name) ?? item.text;
    putDraft(item.name, { text: t, base: item.library ?? '' });
    this.keep(item);
  }

  /** Conflict, "Use the library's": my version is dropped. */
  useLibrary(item: Restored) {
    this.discard(item);
  }

  /** The restored item for an effect, while it is undecided. */
  effectItem(name: string) {
    return this.restored.find((r) => r.kind === 'effect' && r.name === name) as Extract<Restored, { kind: 'effect' }> | undefined;
  }

  /** Asks RestoreNote to show the two versions of an effect. */
  requestCompare(name: string) { this.compareSubs.forEach((f) => f(name)); }
  onCompare(fn: (name: string) => void): () => void {
    this.compareSubs.add(fn);
    return () => { this.compareSubs.delete(fn); };
  }

  /** "Close without saving": forget the changes it named and write what is left (restored settings for boards
   * that never connected stay), then stop writing. */
  async discardForClose(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    dropAll();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const folder = this.folder;
    await this.writing;
    this.stopped = true;
    if (!folder) return;
    try {
      if (this.pending.size) await this.call('unsaved_put', { folder, ...this.snapshot() });
      else await this.call('unsaved_clear', { folder });
    } catch { /* closing anyway */ }
  }
}

export const hotExit = new HotExit();

// a browser tab closing or reloading: write at once (the debounce may not have run yet)
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { void hotExit.flush(); });

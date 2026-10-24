import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HotExit, PERSIST_MS } from './hotexit';
import { dropAll, getDraft, getDraftEntry, setDraft, settingsMeta, unsavedSettings } from './drafts';

// The device layer, faked: one disk copy per folder, compared with a library the test sets.
function fakeCore(library: Record<string, string> = {}) {
  const disk: Record<string, any> = {};
  const calls: { cmd: string; args: any }[] = [];
  const hash = (t: string) => t.replace(/\r\n/g, '\n').trimEnd();
  const call = vi.fn(async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
    if (cmd === 'unsaved_put') {
      const effects: Record<string, any> = {};
      for (const [n, d] of Object.entries<any>(args.effects)) effects[n] = { text: d.text, base_hash: d.base_hash ?? hash(d.base ?? '') };
      if (!Object.keys(effects).length && !Object.keys(args.settings).length) delete disk[args.folder];
      else disk[args.folder] = { effects, settings: args.settings };
      return null;
    }
    if (cmd === 'unsaved_get') {
      const d = disk[args.folder];
      if (!d) return { effects: [], settings: {} };
      const effects = Object.entries<any>(d.effects).flatMap<any>(([name, e]) => {
        const lib = library[name];
        if (lib === undefined) return [{ name, text: e.text, base_hash: e.base_hash, library: null, conflict: false, missing: true }];
        if (hash(lib) === hash(e.text)) return [];
        return [{ name, text: e.text, base_hash: e.base_hash, library: lib, conflict: e.base_hash !== hash(lib), missing: false }];
      });
      return { effects, settings: d.settings };
    }
    if (cmd === 'unsaved_clear') { delete disk[args.folder]; return null; }
    throw new Error(`unexpected ${cmd}`);
  });
  return { call, disk, calls, library };
}

let instances: HotExit[] = [];
function make(core: ReturnType<typeof fakeCore>) {
  const h = new HotExit(core.call as any);
  instances.push(h);
  return h;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  instances.forEach((h) => h.dispose());
  instances = [];
  dropAll();
  settingsMeta.clear();
  vi.useRealTimers();
});

describe('hot exit: the disk copy', () => {
  it('writes a moment after the last change, never before the restore has read what is there', async () => {
    const core = fakeCore({ fog: 'effect fog:\n' });
    const h = make(core);
    setDraft('fog', 'effect fog:\n  rly1 = on\n', 'effect fog:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS * 3);
    expect(core.calls.filter((c) => c.cmd === 'unsaved_put')).toHaveLength(0); // the startup race: nothing erased
    await h.restore('/props');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    const puts = core.calls.filter((c) => c.cmd === 'unsaved_put');
    expect(puts).toHaveLength(1);
    expect(puts[0].args.effects).toEqual({ fog: { text: 'effect fog:\n  rly1 = on\n', base: 'effect fog:\n' } });
    // typing fast: one write after the typing stops
    for (const ch of 'abcdef') { setDraft('fog', `effect fog:\n  rly1 = on\n# ${ch}`, 'effect fog:\n'); await vi.advanceTimersByTimeAsync(50); }
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(core.calls.filter((c) => c.cmd === 'unsaved_put')).toHaveLength(2);
    // saved: nothing unsaved is left on disk
    setDraft('fog', 'effect fog:\n', 'effect fog:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(core.disk['/props']).toBeUndefined();
  });

  it('restores after a crash, and Keep / Discard decide each item', async () => {
    const core = fakeCore({ fog: 'effect fog:\n', lamp: 'effect lamp:\n' });
    const first = make(core);
    await first.restore('/props');
    setDraft('fog', 'effect fog:\n  sleep 5\n', 'effect fog:\n');
    setDraft('lamp', 'effect lamp:\n  out1 = on\n', 'effect lamp:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    // the app is killed: memory is gone, the disk copy is not
    first.dispose(); dropAll();
    const h = make(core);
    const items = await h.restore('/props');
    expect(items.map((i) => i.kind === 'effect' && [i.name, i.conflict, i.missing])).toEqual([['fog', false, false], ['lamp', false, false]]);
    expect(getDraft('fog')).toBe('effect fog:\n  sleep 5\n');
    h.keep(items[0]);
    expect(getDraft('fog')).toBe('effect fog:\n  sleep 5\n'); // kept as an unsaved edit
    h.discard(h.restored[0]);
    expect(getDraft('lamp')).toBeUndefined();
    expect(h.restored).toEqual([]);
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(Object.keys(core.disk['/props'].effects)).toEqual(['fog']);
    // an undecided item stays on disk too: a second crash before deciding loses nothing
    h.dispose(); dropAll();
    const again = make(core);
    expect((await again.restore('/props')).map((i) => i.kind === 'effect' && i.name)).toEqual(['fog']);
  });

  it('an effect saved elsewhere since: both versions, the person picks', async () => {
    const core = fakeCore({ fog: 'effect fog:\n' });
    const first = make(core);
    await first.restore('/props');
    setDraft('fog', 'mine\n', 'effect fog:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    first.dispose(); dropAll();
    core.library.fog = 'saved on the laptop\n';
    const h = make(core);
    const [item] = await h.restore('/props');
    expect(item).toMatchObject({ kind: 'effect', name: 'fog', conflict: true, text: 'mine\n', library: 'saved on the laptop\n' });
    // it stays a conflict on disk until decided (the hash it started from is kept)
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(core.disk['/props'].effects.fog.base_hash).toBe('effect fog:');
    h.keepMine(item);
    expect(getDraftEntry('fog')).toEqual({ text: 'mine\n', base: 'saved on the laptop\n' });
    expect(h.restored).toEqual([]);
    // or the library's version
    setDraft('fog', 'mine again\n', 'effect fog:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    h.dispose(); dropAll();
    const h2 = make(core);
    const [it2] = await h2.restore('/props');
    h2.useLibrary(it2);
    expect(getDraft('fog')).toBeUndefined();
  });

  it('a deleted effect is offered back; edits made in this session win over restored ones', async () => {
    const core = fakeCore({});
    core.disk['/props'] = { effects: { gone: { text: 'effect g:\n', base_hash: 'x' }, open: { text: 'old\n', base_hash: 'x' } }, settings: {} };
    core.library.open = 'x';
    setDraft('open', 'typed just now\n', 'x');
    const h = make(core);
    const items = await h.restore('/props');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'gone', missing: true });
    expect(getDraft('open')).toBe('typed just now\n');
  });

  it('board settings: secrets never written, restored to the board with the same id when it connects', async () => {
    const core = fakeCore();
    const first = make(core);
    await first.restore('/props');
    settingsMeta.set('sim:5001', { id: 'a0b1', name: 'Front door', base: { debounce_ms: 100, wifi_pass: '' }, secrets: ['wifi_pass'] });
    unsavedSettings.set('sim:5001', { debounce_ms: 120, wifi_pass: 'hunter22' });
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(JSON.stringify(core.disk)).not.toContain('hunter22');
    expect(core.disk['/props'].settings).toEqual({ a0b1: { name: 'Front door', key: 'sim:5001', edits: { debounce_ms: 120 }, base: { debounce_ms: 100 } } });
    first.dispose(); dropAll(); settingsMeta.clear();
    const h = make(core);
    const [item] = await h.restore('/props');
    expect(item).toMatchObject({ kind: 'settings', id: 'a0b1', name: 'Front door' });
    // a practice board gets a new key every start: matched by its id
    h.boardConnected('sim:6002', 'zzzz', 'Other');
    expect(unsavedSettings.size).toBe(0);
    h.boardConnected('sim:6002', 'a0b1', 'Front door');
    expect(unsavedSettings.get('sim:6002')).toEqual({ debounce_ms: 120 });
    expect(settingsMeta.get('sim:6002')?.base).toEqual({ debounce_ms: 100 });
    expect(h.restored[0]).toMatchObject({ board: 'sim:6002' });
    h.discard(h.restored[0]);
    expect(unsavedSettings.size).toBe(0);
  });

  it('"Close without saving" forgets the changes it named; restored settings for an absent board stay', async () => {
    const core = fakeCore({ fog: 'effect fog:\n' });
    core.disk['/props'] = { effects: {}, settings: { b1: { name: 'Barn', edits: { volume: 20 }, base: {} } } };
    const h = make(core);
    await h.restore('/props');
    setDraft('fog', 'changed\n', 'effect fog:\n');
    await h.discardForClose();
    expect(getDraft('fog')).toBeUndefined();
    expect(core.disk['/props'].effects).toEqual({});
    expect(core.disk['/props'].settings.b1.edits).toEqual({ volume: 20 });
    // and nothing is written after that
    setDraft('fog', 'late\n', 'effect fog:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(core.disk['/props'].effects).toEqual({});
    // with nothing else left, the disk copy is cleared
    const core2 = fakeCore({ fog: 'effect fog:\n' });
    const h2 = make(core2);
    await h2.restore('/p2');
    setDraft('fog', 'x\n', 'effect fog:\n');
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(core2.disk['/p2']).toBeDefined();
    await h2.discardForClose();
    expect(core2.disk['/p2']).toBeUndefined();
    expect(core2.calls.at(-1)?.cmd).toBe('unsaved_clear');
  });

  it('a library that cannot be read starts clean and writes nothing over it', async () => {
    const call = vi.fn(async (cmd: string) => { if (cmd === 'unsaved_get') throw new Error('offline'); return null; });
    const h = new HotExit(call as any); instances.push(h);
    expect(await h.restore('/props')).toEqual([]);
    await vi.advanceTimersByTimeAsync(PERSIST_MS + 10);
    expect(call.mock.calls.filter((c) => c[0] === 'unsaved_put')).toHaveLength(0);
  });
});

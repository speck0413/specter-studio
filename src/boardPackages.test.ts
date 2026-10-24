import { describe, expect, it } from 'vitest';
import {
  BoardAnswer, BoardFiles, chipFits, fileArg, fileChoices, FORGET, KEEP, NONE, packageArg, packageChoices, releasePresets, restartWords,
  RESTART_TITLE, sendSetup, sendWhenBack, SetupError, takesPackages, writesImage,
} from './boardPackages';
import { describePerms, fingerprint, perms } from './components/pluginPerms';
import { firmwarePlugins } from './firmware';

const plugin = { id: 'lamps', name: 'Demo lamps' };
const files: BoardFiles = {
  packages: [
    { plugin, file: 'board-packages/lamp.json', name: 'Demo lamp board', id: 'lamp-board', mcu: 'esp32-devkit' },
    { plugin, file: 'board-packages/pico.json', name: 'Pico lamp', id: 'pico-lamp', mcu: 'pico' },
    { plugin, file: 'board-packages/on-base.json', name: 'Lamp words only', id: 'lamp-base', mcu: null, base: 'proptroller' },
    { plugin, file: 'board-packages/broken.json', name: 'board-packages/broken.json', error: 'this is not a board package (not JSON: …)' },
  ],
  profiles: [{ plugin, file: 'profiles/lamp.json', name: 'Lamp words' }],
  scripts: [{ plugin, file: 'scripts/blink.txt', name: 'Blink twice' }],
};
const board: BoardAnswer = {
  kind: 'board', mcu: 'esp32-devkit',
  running: { id: 'proptroller', name: 'Proptroller board', source: 'built-in' },
  stored: { id: 'lamp-board', name: 'Demo lamp board', pending: true },
  presets: [{ id: 'proptroller', name: 'Proptroller board' }, { id: 'relay4-button', name: 'Relay board' }],
};

describe('board packages', () => {
  it('know firmware that takes them by its capability', () => {
    expect(takesPackages({ capabilities: ['pin', 'board_package'] })).toBe(true);
    expect(takesPackages({ capabilities: ['pin'] })).toBe(false);
    expect(takesPackages(undefined)).toBe(false);
  });

  it('match a package to the board\'s chip (the board checks the rest)', () => {
    expect(chipFits('esp32-devkit', 'esp32-devkit')).toBe(true);
    expect(chipFits('pico', 'pico-w')).toBe(true);
    expect(chipFits('pico', 'pico2-w')).toBe(true);
    expect(chipFits('pico', 'esp32-devkit')).toBe(false);
    expect(chipFits('esp32-devkit', 'pico-w')).toBe(false);
    expect(chipFits(null, 'pico-w')).toBe(true);
  });

  it('a connected board: keep, its presets, the files, forget the stored one', () => {
    const c = packageChoices({ board, files });
    expect(c.map((x) => x.name)).toEqual(['Keep Proptroller board', 'Proptroller board (built in)', 'Relay board (built in)', 'Demo lamp board', 'Pico lamp', 'Lamp words only', 'board-packages/broken.json', 'Forget the stored board package']);
    expect(c[0].note).toContain('Demo lamp board is stored and starts at the next restart');
    expect(c.find((x) => x.name === 'Demo lamp board')).toMatchObject({ disabled: false, note: 'From the extension “Demo lamps”' });
    expect(c.find((x) => x.name === 'Pico lamp')).toMatchObject({ disabled: true, note: 'Made for a Raspberry Pi Pico board' });
    expect(c.find((x) => x.name === 'Lamp words only')?.disabled).toBe(false);
    expect(c.find((x) => x.name === 'board-packages/broken.json')?.note).toMatch(/^Cannot be used: this is not a board package/);
    expect(c.at(-1)?.value).toBe(FORGET);
  });

  it('a new board over USB: the release\'s presets, else the Proptroller board, and nothing to keep', () => {
    const c = packageChoices({ presets: releasePresets({}), files, mcu: 'pico-w' });
    expect(c[0]).toMatchObject({ value: 'preset:proptroller', name: 'Proptroller board (built in)' });
    expect(c.some((x) => x.value === KEEP || x.value === FORGET)).toBe(false);
    expect(c.find((x) => x.name === 'Demo lamp board')?.disabled).toBe(true);
    expect(releasePresets({ presets: ['proptroller', { id: 'relay4-button', name: 'Relay board' }, 7] })).toEqual([{ id: 'proptroller', name: 'proptroller' }, { id: 'relay4-button', name: 'Relay board' }]);
  });

  it('turn a choice into board_setup arguments', () => {
    const c = packageChoices({ board, files });
    const lamp = c.find((x) => x.name === 'Demo lamp board')!.value;
    expect(packageArg(KEEP, files)).toBeNull();
    expect(packageArg('preset:relay4-button', files)).toEqual({ preset: 'relay4-button' });
    expect(packageArg(FORGET, files)).toEqual({ forget: true });
    expect(packageArg(lamp, files)).toEqual({ plugin: 'lamps', file: 'board-packages/lamp.json' });
    expect(writesImage(lamp)).toBe(true);
    expect(writesImage('preset:proptroller')).toBe(false);
    const p = fileChoices(files.profiles);
    expect(p.map((x) => x.name)).toEqual(['None (keep the board’s)', 'Lamp words']);
    expect(fileArg(NONE, files.profiles)).toBeUndefined();
    expect(fileArg(p[1].value, files.profiles)).toEqual({ plugin: 'lamps', file: 'profiles/lamp.json' });
  });

  it('send the requests one by one and stop at a refusal, in the board\'s own words', async () => {
    const sent: any[] = [];
    const steps: string[] = [];
    const ok = (result: any) => ({ ok: true, result });
    const answers: Record<string, any> = {
      set_board: ok({ kind: 'board_set', id: 'lamp-board', name: 'Demo lamp board', restart_needed: true, warnings: ['OUT4 has no pin'] }),
      set_profile: ok({ kind: 'done' }),
      set_script: ok({ kind: 'script_check', ok: true, warnings: [] }),
    };
    const reqs = [{ op: 'set_board', package: { id: 'lamp-board' }, defaults: 'apply' }, { op: 'set_profile', data: {} }, { op: 'set_script', text: 'x' }];
    const r = await sendSetup(async (q) => { sent.push(q); return answers[q.op]; }, reqs, (s) => steps.push(s));
    expect(sent.map((q) => q.op)).toEqual(['set_board', 'set_profile', 'set_script']);
    expect(steps).toEqual(['Sending the board package…', 'Sending the profile…', 'Sending the script…']);
    expect(r).toEqual({ name: 'Demo lamp board', warnings: ['OUT4 has no pin'] });

    const refused: any[] = [];
    const msg = 'TRIG2: GPIO 35 is input-only, so it cannot have the board pull';
    await expect(sendSetup(async (q) => { refused.push(q); return { ok: false, error: { code: 'invalid', message: msg } }; }, reqs))
      .rejects.toThrow(`The board did not take the board package: ${msg}`);
    expect(refused.length).toBe(1);
    const late = await sendSetup(async (q) => (q.op === 'set_script' ? ok({ ok: false, errors: [{ message: 'line 1: unknown word' }] }) : answers[q.op]), reqs).catch((e) => e);
    expect(late).toBeInstanceOf(SetupError);
    expect(late.message).toBe('The board did not take the script: line 1: unknown word');
    // the board package was taken before: the caller still asks about the restart
    expect(late.sent).toEqual(['set_board', 'set_profile']);
  });

  it('ask before the restart in plain words', () => {
    const w = restartWords('Front door', 'Demo lamp board');
    expect(w.title).toBe(RESTART_TITLE);
    expect(w.title).toBe('Restart now to use the new board package?');
    expect(w.text).toContain('keeps using its old pins until it restarts');
  });

  it('an extension that offers board files asks for consent and is listed once allowed', () => {
    const p = { id: 'lamp-files', name: 'Lamp files', dir: '/x', board_packages: ['a.json'], profiles: [{ name: 'Lamp words', file: 'p.json' }], scripts: [{ name: 'Blink', file: 's.txt' }] };
    expect(perms(p).boardFiles.board_packages).toEqual(['a.json']);
    expect(describePerms(perms(p)).join(' ')).toContain('Offer for your boards: 1 board package, profiles (Lamp words), scripts (Blink)');
    expect(firmwarePlugins([p], {})).toEqual([]);
    expect(firmwarePlugins([p], { 'lamp-files': fingerprint(p) })).toEqual(['lamp-files']);
    // a plugin without them keeps the fingerprint it had before they existed
    const plain = { id: 'probe', name: 'Probe', dir: '/y', mqtt: ['a/#'] };
    expect(fingerprint(plain)).toBe(fingerprint({ ...plain, board_packages: [], profiles: [], scripts: [] }));
    expect(fingerprint({ ...plain, scripts: [{ name: 'B', file: 'b.txt' }] })).not.toBe(fingerprint(plain));
  });

  it('send the profile and script once the board answers again after its restart', async () => {
    const sent: string[] = [];
    let up = 0;
    const send = async (q: any) => {
      sent.push(q.op);
      if (q.op === 'info') return ++up >= 3 ? { ok: true, result: {} } : { ok: false, error: { code: 'gone', message: 'not connected' } };
      return { ok: true, result: q.op === 'set_script' ? { ok: true } : {} };
    };
    expect(await sendWhenBack(send, [{ op: 'set_profile', data: {} }, { op: 'set_script', text: 'x' }], undefined, 1000, 1)).toBe(true);
    expect(sent).toEqual(['info', 'info', 'info', 'set_profile', 'set_script']);
    // nothing to send: nothing asked
    const none: string[] = [];
    expect(await sendWhenBack(async (q) => { none.push(q.op); return { ok: true }; }, [])).toBe(true);
    expect(none).toEqual([]);
    // never back: false, nothing sent
    const gone: string[] = [];
    expect(await sendWhenBack(async (q) => { gone.push(q.op); return { ok: false }; }, [{ op: 'set_script', text: 'x' }], undefined, 5, 1)).toBe(false);
    expect(gone.every((o) => o === 'info')).toBe(true);
  });
});

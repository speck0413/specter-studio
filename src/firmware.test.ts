import { describe, expect, it } from 'vitest';
import { boardPackageName, freshWords, firmwareArgsOf, firmwareKind, firmwarePlugins, firstFlashBoards, typeName, typeOptions, waitingFirmwarePlugins, switchWords, GENERIC_NAME, Catalog } from './firmware';
import { describePerms, fingerprint, perms } from './components/pluginPerms';
import { needsConsent } from './components/PluginConsent';

const lamps = { id: 'lamps', name: 'Lamps', dir: '/p/lamps', firmware: [{ fw: 'lamp', name: 'Demo lamp', source: 'releases' }] };
const probe = { id: 'probe', name: 'Probe', dir: '/p/probe', mqtt: ['x/#'] };

const catalog: Catalog = {
  types: [
    { fw: 'generic', name: GENERIC_NAME, plugin: null, version: '0.1.0' },
    { fw: 'lamp', name: 'Demo lamp', plugin: { id: 'lamps', name: 'Lamps' }, version: '4.0.0' },
  ],
  images: [
    { fw: 'generic', mcu: 'esp32-devkit', file: 'g.bin', version: '0.1.0' },
    { fw: 'generic', mcu: 'esp32-devkit', file: 'g-first.bin', first_flash: true, version: '0.1.0' },
    { fw: 'generic', mcu: 'pico-w', file: 'g-first.uf2', first_flash: true, version: '0.1.0' },
    { fw: 'lamp', mcu: 'esp32-devkit', file: 'l.bin', version: '4.0.0' },
    { fw: 'lamp', mcu: 'esp32-devkit', file: 'l-first.bin', first_flash: true, version: '4.0.0' },
  ],
};

describe('Allow betas', () => {
  it('is off unless turned on, and every firmware request says so', () => {
    expect(firmwareArgsOf({ releases: '' }, [])).toEqual({ source: '', plugins: [], betas: false });
    expect(firmwareArgsOf({ releases: '/rel', betas: true }, []).betas).toBe(true);
    expect(firmwareArgsOf({ releases: '', betas: false }, []).betas).toBe(false);
  });
  it('a type whose newest list is a pre-release says beta in the dropdown', () => {
    const c: Catalog = { types: [{ fw: 'generic', name: GENERIC_NAME, plugin: null, version: '0.2.0-rc.1', prerelease: true }], images: [{ fw: 'generic', mcu: 'pico', first_flash: true }] };
    expect(typeOptions(c, { mcu: 'pico', firstFlash: true })[0].note).toBe('Beta (a test version)');
  });
});

describe('firmware types from plugins', () => {
  it('a plugin list adds a type only once the person allowed exactly that plugin.json', () => {
    expect(firmwarePlugins([lamps, probe], {})).toEqual([]);
    expect(waitingFirmwarePlugins([lamps, probe], {}).map((p) => p.id)).toEqual(['lamps']);
    const consent = { lamps: fingerprint(lamps) };
    expect(firmwarePlugins([lamps, probe], consent)).toEqual(['lamps']);
    expect(waitingFirmwarePlugins([lamps, probe], consent)).toEqual([]);
    // the list moved somewhere else: asked again
    const moved = { ...lamps, firmware: [{ fw: 'lamp', name: 'Demo lamp', source: 'https://example.com/x.json' }] };
    expect(firmwarePlugins([moved], consent)).toEqual([]);
  });

  it('offering firmware is on the consent screen; plugins without it keep their old consent', () => {
    expect(needsConsent({ id: 'only-firmware', firmware: lamps.firmware })).toBe(true);
    expect(describePerms(perms(lamps))).toEqual(['Offer firmware for your boards: Demo lamp (Studio installs it only when you choose it)']);
    // a plugin.json without "firmware" has the same fingerprint as before firmware offers existed
    expect(fingerprint(probe)).toBe(fingerprint({ ...probe, firmware: [] }));
    expect(fingerprint(probe)).not.toBe(fingerprint({ ...probe, firmware: lamps.firmware }));
  });
});

describe('the firmware dropdown', () => {
  it('stock first, plugin types after, with friendly names', () => {
    const o = typeOptions(catalog);
    expect(o.map((x) => x.name)).toEqual(['Generic (stock)', 'Demo lamp']);
    expect(o[1].note).toBe('From the extension “Lamps”');
  });

  it('a USB install offers only the types that have an image for that board', () => {
    const pico = typeOptions(catalog, { mcu: 'pico-w', firstFlash: true });
    expect(pico.map((x) => [x.fw, x.disabled])).toEqual([['generic', false], ['lamp', true]]);
    expect(pico[1].note).toBe('No USB install for this kind of board');
    expect(firstFlashBoards(catalog, 'generic').map((k) => k.key)).toEqual(['proptroller/esp32-devkit', 'proptroller/pico-w']);
    expect(firstFlashBoards(catalog, 'lamp').map((k) => k.key)).toEqual(['proptroller/esp32-devkit']);
  });

  it('marks the type on the board, and a list that cannot be read', () => {
    const o = typeOptions({ ...catalog, types: [catalog.types[0], { ...catalog.types[1], error: 'needs the internet' }] }, { mcu: 'esp32-devkit', current: 'generic' });
    expect(o[0]).toEqual({ fw: 'generic', name: GENERIC_NAME, disabled: false, note: 'On the board now' });
    expect(o[1].disabled).toBe(true);
    expect(o[1].note).toMatch(/needs the internet/);
    // the board's own type even when its list has nothing for this board (a practice board, say)
    expect(typeOptions(catalog, { mcu: 'sim', current: 'generic' }).map((x) => [x.note, x.disabled])).toEqual([['On the board now', false], ['No firmware for this kind of board', true]]);
  });

  it('keys on type, board package and chip; old lists and boards are the Proptroller board', () => {
    const c: Catalog = { types: catalog.types, images: [
      ...catalog.images,
      { fw: 'lamp', mcu: 'esp32-devkit', board: 'lamp-board', board_name: 'Lamp board rev B', file: 'lb.bin' },
      { fw: 'lamp', mcu: 'esp32-devkit', board: 'lamp-board', board_name: 'Lamp board rev B', file: 'lb-first.bin', first_flash: true },
      { fw: 'lamp', mcu: 'esp32-devkit', board: 'bare-board', file: 'bb-first.bin', first_flash: true },
    ] };
    expect(firstFlashBoards(c, 'lamp').map((k) => [k.key, k.boardName])).toEqual([
      ['proptroller/esp32-devkit', 'Proptroller board'], ['lamp-board/esp32-devkit', 'Lamp board rev B'], ['bare-board/esp32-devkit', 'bare-board']]);
    // a lamp-board ESP32: the stock list has nothing for that board package
    const o = typeOptions(c, { mcu: 'esp32-devkit', board: 'lamp-board' });
    expect(o.map((x) => [x.fw, x.disabled])).toEqual([['generic', true], ['lamp', false]]);
    // no board given: the Proptroller board
    expect(typeOptions(c, { mcu: 'esp32-devkit' }).map((x) => x.disabled)).toEqual([false, false]);
  });

  it('nothing published yet is said calmly', () => {
    const o = typeOptions({ ...catalog, types: [{ ...catalog.types[0], error: 'there is no firmware release there yet' }, catalog.types[1]] }, { firstFlash: true });
    expect(o[0]).toEqual({ fw: 'generic', name: GENERIC_NAME, disabled: true, note: 'No release published yet' });
  });

  it('names a type, and a switch names both', () => {
    expect(typeName(catalog, 'lamp')).toBe('Demo lamp');
    expect(typeName(null, 'generic')).toBe(GENERIC_NAME);
    expect(typeName(catalog, 'my-sketch')).toBe('my-sketch');
    const w = switchWords('Porch', 'Generic (stock)', 'Demo lamp');
    expect(w.title).toBe('Replace the Generic (stock) firmware on Porch with Demo lamp?');
    expect(w.text).toMatch(/backup/);
  });
});

describe('what a board runs', () => {
  it('a type with a list is a release, not a custom firmware; the library\'s own sketch stays yours', () => {
    const pluginType = { kind: 'custom', name: 'lamp', version: 4, status: 'unknown' };
    expect(firmwareKind(pluginType, { type_name: 'Demo lamp', latest: '4.0.0' })).toEqual({ kind: 'release' });
    expect(firmwareKind(pluginType, { type_name: null })).toBe(pluginType);
    const mine = { kind: 'custom', name: 'lamp', version: 4, status: 'current' };
    expect(firmwareKind(mine, { type_name: 'Demo lamp' })).toBe(mine);
    expect(firmwareKind(null, undefined)).toEqual({ kind: 'release' });
  });
});

describe('start fresh', () => {
  it('names the board and the firmware, and says the Wi-Fi goes', () => {
    const w = freshWords('Porch', 'Demo lamp');
    expect(w.title).toBe("Start Porch fresh with the Demo lamp firmware's defaults?");
    expect(w.text).toMatch(/Wi-Fi/);
    expect(w.text).toMatch(/Back it up/);
  });
});

describe('board package names', () => {
  it('the list\'s name, else Proptroller board, else the id', () => {
    expect(boardPackageName({ board: 'lamp-board' }, { image: { board_name: 'Lamp board rev B' } })).toBe('Lamp board rev B');
    expect(boardPackageName({ board: 'proptroller' })).toBe('Proptroller board');
    expect(boardPackageName({})).toBe('Proptroller board');
    expect(boardPackageName({ board: 'lamp-board' }, { image: null })).toBe('lamp-board');
  });
});


describe('the generic release that comes with Studio', () => {
  it('is offered with the Proptroller board for a USB install, and says it comes with Studio', async () => {
    const { typeOptions, firstFlashBoards, NO_FIRMWARE_YET } = await import('./firmware');
    const c = { types: [{ fw: 'generic', name: 'Generic (stock)', plugin: null, version: '0.1.0-rc.2', bundled: true }],
      images: [{ fw: 'generic', impl: 'cpp', mcu: 'esp32-devkit', board: 'proptroller', file: 'first-flash-esp32-devkit-0.1.0-rc.2.bin', first_flash: true }] };
    expect(typeOptions(c, { firstFlash: true })).toEqual([{ fw: 'generic', name: 'Generic (stock)', disabled: false, note: '0.1.0-rc.2 comes with Studio' }]);
    expect(firstFlashBoards(c, 'generic').map((k) => `${k.mcu} ${k.boardName}`)).toEqual(['esp32-devkit Proptroller board']);
    // nothing at all: the words the USB install shows (with Choose a folder…)
    expect(firstFlashBoards({ types: c.types, images: [] }, 'generic')).toEqual([]);
    expect(NO_FIRMWARE_YET).toBe('No firmware found yet (no release published).');
  });
});

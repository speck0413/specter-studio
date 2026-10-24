import { describe, expect, it } from 'vitest';
import { ACTIVITY_EMPTY, actionHelp, boardKind, conflicts, connectError, practiceName, firmwareBadge, driverText, guidePage, inputStatus, relayNote, checkHint, lineHint, missingHint, optionWords, statusText } from './words';
import { changes } from './store';
import { starterScript } from './components/NewEffect';

describe('plain words', () => {
  it('warn when a show and the effect script share an input', () => {
    const b: any = { script: { text: 'effect a:\n  wait for trig1\n' }, shows: [{ id: 1, name: 'Door', enabled: true, inputs: ['TRIG1'] }, { id: 2, name: 'Off', enabled: false, inputs: ['TRIG1'] }] };
    expect(conflicts(b)).toEqual(['TRIG1 starts both the show “Door” and the effect script: one press runs both.']);
    expect(conflicts({ ...b, script: { text: 'effect a:\n wait for trig2\n' } })).toEqual([]);
    // a commented-out line starts nothing on the board
    expect(conflicts({ ...b, script: { text: 'effect a:\n wait for trig2\n # wait for trig1\n' } })).toEqual([]);
    expect(conflicts({ ...b, script: { text: 'effect a:\n WaitFor TRIG1.  # the door\n' } })).toHaveLength(1);
  });
  it('log presses and effects from state changes', () => {
    const s1 = { inputs: [{ input: 'TRIG1', raw: false }], script: { effects: [{ name: 'porch', running: false }] } };
    const s2 = { inputs: [{ input: 'TRIG1', raw: true }], script: { effects: [{ name: 'porch', running: true }] } };
    expect(changes(s1, s2).map((c) => c.text)).toEqual(['TRIG1 pressed', 'Effect “porch” started']);
    expect(changes(s2, s1).map((c) => c.text)).toEqual(['TRIG1 let go', 'Effect “porch” finished']);
  });
  it('stop offering an update that did not take', () => {
    const b: any = { info: { fw_version: '0.1.0' }, firmware: { custom: { kind: 'release' }, plan: { latest: '0.2.0', current: '0.1.0', out_of_date: true } } };
    expect(firmwareBadge(b).label).toBe('Firmware update available: 0.2.0');
    // a board without over-the-air updates is told to use USB, never offered an update it would refuse
    const usb = firmwareBadge({ ...b, firmware: { ...b.firmware, plan: { latest: '0.2.0', current: '0.1.0', out_of_date: false, usb_update: true } } } as any);
    const moved = firmwareBadge({ ...b, firmware: { ...b.firmware, plan: { latest: '0.2.0', current: '0.1.0', out_of_date: false, usb_update: true, usb_reason: 'install over USB so the board package goes on with it' } } } as any);
    expect(moved.help).toContain('Not over Wi-Fi: install over USB so the board package goes on with it');
    expect(usb.label).toBe('Firmware 0.2.0 available (over USB)');
    expect(usb.help).toMatch(/Put firmware on a new board \(USB\)/);
    expect(firmwareBadge({ ...b, lastUpdate: { result: 'rolled_back', version: '0.2.0' } }).label).toBe('Update to 0.2.0 did not take');
  });
  it('say "beta" when the offered version is a pre-release', () => {
    const b: any = { info: { fw_version: '0.1.0' }, firmware: { custom: { kind: 'release' }, plan: { latest: '0.2.0-rc.1', current: '0.1.0', out_of_date: true, prerelease: true } } };
    expect(firmwareBadge(b).label).toBe('Firmware update available: 0.2.0-rc.1 (beta)');
    expect(firmwareBadge(b).help).toMatch(/test version/);
    const usb = firmwareBadge({ ...b, firmware: { ...b.firmware, plan: { ...b.firmware.plan, out_of_date: false, usb_update: true } } });
    expect(usb.label).toBe('Firmware 0.2.0-rc.1 (beta) available (over USB)');
  });
  it('say calmly when the release source has nothing published yet, and plainly when offline', () => {
    const b: any = { info: { fw_version: '0.1.0' }, firmware: { custom: { kind: 'release' }, plan: { latest: null, current: '0.1.0', out_of_date: false, none_yet: true } } };
    expect(firmwareBadge(b)).toMatchObject({ label: 'Firmware 0.1.0', tone: 'default', help: 'No firmware release has been published yet. Studio looks again from time to time.' });
    const off: any = { ...b, firmware: { custom: { kind: 'release' }, plan: { error: 'Checking for firmware updates needs the internet. Without it, download a release folder and choose it in Settings (Advanced).' } } };
    expect(firmwareBadge(off).help).toBe('Checking for firmware updates needs the internet. Without it, download a release folder and choose it in Settings (Advanced).');
    expect(firmwareBadge({ ...b, firmware: { custom: { kind: 'release' }, plan: { error: 'the release list is not JSON' } } }).help).toBe('Cannot check for firmware updates: the release list is not JSON');
  });
});

describe('new effect from plain choices', () => {
  it('writes a script the board takes', () => {
    expect(starterScript('prop: porch', 'trig2', 'rly1', 5, true)).toBe('effect prop porch:\n  wait for trig2\n  rly1 = on\n  audio_single = 1\n  wait 5\n  rly1 = off\n');
    // "#" starts a comment on the board, so "effect prop #2:" would lose its colon (M-colon)
    expect(starterScript('Prop #2', 'trig2', 'rly1', 5, false)).toMatch(/^effect Prop 2:\n/);
    expect(starterScript('#', 'trig1', 'out1', 5, false)).toMatch(/^effect my effect:\n/);
  });
  it('turns a second output on and off with the first', () => {
    expect(starterScript('lamp and prop', 'trig1', 'out1', 5, false, 'rly1')).toBe('effect lamp and prop:\n  wait for trig1\n  out1 = on\n  rly1 = on\n  wait 5\n  rly1 = off\n  out1 = off\n');
    expect(starterScript('x', 'trig1', 'out1', 5, false, 'out1')).toBe(starterScript('x', 'trig1', 'out1', 5, false));
  });
});

describe('a plain hint after "there is no lamp on this board"', () => {
  const msg = (w: string) => `line 3: there is no ${w} on this board. The outputs are out1 to out4, rly1, rly2, cc1 and cc2.`;
  it('uses the names given on the board first', () => {
    const terminals = [{ id: 'OUT1', label: 'lamp' }, { id: 'RLY1', label: 'fog machine' }];
    expect(missingHint(msg('lamp'), terminals)).toBe('Your lamp is on OUT1: write out1 instead of lamp.');
    expect(missingHint(msg('fog'), terminals)).toMatch(/^Your fog machine is on RLY1: write rly1 instead of fog\. .*DMX IN.*not supported\.$/);
  });
  it('then says where that kind of thing usually goes', () => {
    expect(missingHint(msg('lamp'))).toMatch(/out1 to out4/);
    expect(missingHint(msg('fog'))).toMatch(/DMX IN.*dmx1 = on.*Never wire a fog machine's remote to a relay/);
    expect(missingHint(msg('pump'))).toMatch(/out1 to out4/);
    expect(missingHint(msg('sound'))).toMatch(/audio_single = 1/);
    expect(missingHint('line 2: there is no button on this board. The inputs are trig1, trig2 and user1 to user3.')).toMatch(/wait for trig1/);
  });
  it('adds nothing to other messages or unknown words', () => {
    expect(missingHint(msg('zorp'))).toBeNull();
    expect(missingHint('line 3: rly1 can only be on or off, not 50%.')).toBeNull();
  });
});

describe('what kind of board', () => {
  it('a board answer\'s own kind ("info") is not shown as the kind of board', () => {
    expect(boardKind({ kind: 'info', mcu: 'sim' })).toBe('Practice board (on this computer)');
    expect(boardKind({ kind: 'Demo lamp', mcu: 'sim' })).toBe('Demo lamp');
  });
});

describe('input tiles say what the input is doing', () => {
  it('names the record buttons and the pause switch', () => {
    expect(inputStatus({}, 'REC', false)).toMatch(/^Record button/);
    expect(inputStatus({}, 'pause', true)).toMatch(/^Pause switch/);
  });
  it('says stopped, resting or ready', () => {
    expect(inputStatus({ armed: true }, undefined, true)).toBe('Ignored: the board is stopped');
    expect(inputStatus({ armed: false }, undefined, false)).toBe('Resting: not ready to start again yet');
    expect(inputStatus({ armed: true }, undefined, false)).toBe('Ready');
    expect(inputStatus({}, undefined, false)).toBe('Ready');
  });
  it('explain board-supplied actions such as "Save now"', () => {
    expect(actionHelp({ key: 'save' })).toMatch(/memory right now/);
    expect(actionHelp({ key: 'save', help: 'From the board.' })).toBe('From the board.');
    expect(actionHelp({ key: 'mystery' })).toBe('');
  });
});

describe('a way forward for lines people naturally write', () => {
  it('a pause written as wait', () => {
    expect(lineHint('  pause 2 seconds')).toBe('To pause, write "wait 2". ("wait for trig1" waits for an input to be pressed.)');
    expect(lineHint('delay 3')).toMatch(/"wait 3"/);
    // a board whose checker refused "wait 500 ms" is older: it pauses with sleep
    expect(lineHint('wait 500 ms')).toMatch(/older and pauses with "sleep 500 ms"/);
  });
  it('flicker, fade and on/off in the wrong order', () => {
    expect(lineHint('  out2 flicker')).toBe('To flicker, write "flicker out2 for 3" (3 seconds).');
    expect(lineHint('out1 = flicker')).toMatch(/"flicker out1 for 3"/);
    expect(lineHint('rly1 fade')).toMatch(/"fade rly1 to 0% over 2"/);
    expect(lineHint('turn on out3')).toBe('Write "out3 = on".');
    expect(lineHint('rly1 off')).toBe('Write "rly1 = off".');
  });
  it('nothing to add for right lines and other mistakes', () => {
    expect(lineHint('flicker out1 for 3')).toBeNull();
    expect(lineHint('wait for trig1')).toBeNull();
    expect(lineHint('zorp')).toBeNull();
    expect(lineHint(undefined)).toBeNull();
  });
});

describe('the wiring guide for a terminal', () => {
  const pages = ['07-air-valve-on-out.html', '10-pump-or-motor-on-out.html', '00-meet-your-board.html', '01-button-on-trig1.html', '02-lamp-on-out1.html',
    '03-motion-on-trig2.html', '04-speaker-and-sounds.html', '05-pixel-strip.html', '06-fog-over-dmx.html', '09-chaining-two-boards.html', 'index.html'];
  it('its own guide first, then the guide for that kind of terminal', () => {
    expect(guidePage(pages, 'TRIG1')).toBe('01-button-on-trig1.html');
    expect(guidePage(pages, 'OUT1')).toBe('02-lamp-on-out1.html');
    expect(guidePage(pages, 'OUT3')).toBe('02-lamp-on-out1.html');
    expect(guidePage(pages, 'CC1')).toBe('09-chaining-two-boards.html');
    expect(guidePage(pages, 'TRIG2')).toBe('03-motion-on-trig2.html');
  });
  it('else the index', () => {
    expect(guidePage(pages, 'USER1')).toBe('index.html');
  });
  it('a relay: its own guide when there is one, else the tour of the board, with a plain note', () => {
    expect(guidePage(pages, 'RLY1')).toBe('00-meet-your-board.html');
    expect(guidePage([...pages, '11-relay-switching.html'], 'RLY2')).toBe('11-relay-switching.html');
    expect(relayNote(pages, 'RLY1')).toMatch(/^RLY1 is a relay/);
    expect(relayNote([...pages, '11-relay-switching.html'], 'RLY1')).toBeNull();
    expect(relayNote(pages, 'OUT1')).toBeNull();
    expect(guidePage(['index.html'], 'RLY1')).toBe('index.html');
  });
});

describe('an output with a job of its own', () => {
  it('says what the job does', () => {
    expect(driverText('trigger repeat')).toBe('pulses on each trigger (to start the next board)');
    expect(driverText('sound_trigger')).toBe('pulses when a sound starts');
    expect(statusText({ key: 'remote_trigger_by', value: '' })).toEqual(['Remote trigger by', 'none']);
    expect(statusText({ key: 'cooldown_remaining_ms', value: 200, unit: 'ms' })).toEqual(['Cooldown remaining', '0.2 s']);
    expect(statusText({ key: 'run_count', value: 179151, label: 'Time left', unit: 'ms' })).toEqual(['Time left', '2:59']);
    expect(statusText({ key: 'ready', value: true })).toEqual(['Ready', 'yes']);
    expect(driverText('something new')).toBe('something new');
    expect(driverText(undefined)).toBe('');
  });
});

describe('a choice setting in plain words', () => {
  it('takes the words for each option from the board\'s help', () => {
    const help = "switch: switch, button or relay contact (closes to ground). sensor_high: powered sensor (its signal goes high), fed from the jack's ring (3.3 V, 15 mA at most)";
    expect(optionWords({ options: ['switch', 'sensor_high'], help })).toEqual({ switch: 'Switch, button or relay contact (closes to ground)', sensor_high: 'Powered sensor (its signal goes high)' });
    expect(optionWords({ options: ['learn', 'triggers'], help: 'learn = REC / SELECT / TAP record mode' })).toEqual({ learn: 'REC / SELECT / TAP record mode' });
    expect(optionWords({ options: ['a'], help: '' })).toEqual({});
  });
});

describe('adding a board', () => {
  it('a board that does not answer: what to try next', () => {
    const t = connectError('no board answers at http://192.168.1.250', '192.168.1.250');
    expect(t).toMatch(/^No board answered at “192\.168\.1\.250”\. Check that the board is on and on the same Wi-Fi/);
    expect(t).toMatch(/Find boards on my network/);
    expect(connectError('no board answers at http://porch ghost', 'porch ghost')).toMatch(/^A board address has no spaces/);
    expect(connectError('the board is locked', 'x')).toBe('the board is locked');
  });
  it('the next practice board takes the first free number', () => {
    expect(practiceName([])).toBe('Practice board 1');
    expect(practiceName(['Practice board 1', 'Practice board 3'])).toBe('Practice board 2');
    expect(practiceName(['Porch ghost', 'Practice board 2'])).toBe('Practice board 1');
  });
});

describe('an empty activity log', () => {
  it('says what a press that never shows up means', () => {
    expect(ACTIVITY_EMPTY).toMatch(/^Nothing yet\./);
    expect(ACTIVITY_EMPTY).toMatch(/the board does not see it: check its wiring/);
    expect(ACTIVITY_EMPTY).not.toMatch(/JSON|protocol|_/);
  });
});

describe('the hint under a checker message never repeats or contradicts it', () => {
  it('older checker: "wait 3" only got "wait for trig1", so it is told that board pauses with sleep', () => {
    expect(checkHint('line 4: write it as "wait for trig1".', '  wait 3')).toMatch(/sleep 3/);
  });
  it('newer checker already says how (e10, e20, e41): no second line', () => {
    expect(checkHint('line 4: to wait a time, write "sleep 3"; to wait for an input, write "wait for trig1".', '  wait 3')).toBeNull();
    expect(checkHint('line 3: to play a sound, write "audio_single = 1".', '  play sound 1')).toBeNull();
    expect(checkHint('line 3: say which sound, for example "audio_single = 1" (plays /01/001.mp3).', '  audio_single =')).toBeNull();
    expect(checkHint('line 5: write it as "out1 = on".', '  out1 on')).toBeNull();
  });
  it('the board\'s own names still come first', () => {
    expect(checkHint('line 3: there is no lamp on this board.', '  lamp = on', [{ id: 'OUT1', label: 'lamp' }])).toMatch(/^Your lamp is on OUT1/);
  });
});

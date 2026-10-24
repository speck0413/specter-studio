import { describe, expect, it } from 'vitest';
import { changeWords, defaultsWords, firmwareChange, hasDefaultsOp, keepValues, keptKey, noteFirstSeen, scriptQuestion, sigOf } from './freshStart';
import { freshWords } from './firmware';

const info = (fw: string, board?: string) => ({ id: 'a0b1c2', name: 'Front door', fw, ...(board ? { board } : {}) });

describe('Start fresh', () => {
  it('remembers what a board runs the first time Studio sees it, and no banner then', () => {
    expect(sigOf(info('generic'))).toEqual({ fw: 'generic', board: 'proptroller' });
    expect(sigOf({ fw: 'generic' })).toBeNull(); // no id: nothing to remember it by
    const seen = noteFirstSeen({}, [info('generic'), { name: 'no id' }]);
    expect(seen).toEqual({ a0b1c2: { fw: 'generic', board: 'proptroller' } });
    expect(noteFirstSeen(seen!, [info('demo-lamp')])).toBeNull(); // known: left as it was
    expect(firmwareChange(seen!, {}, info('generic'))).toBeNull();
    expect(firmwareChange(undefined, {}, info('generic'))).toBeNull();
  });

  it('shows the banner for another firmware type or board package until Keep mine', () => {
    const seen = { a0b1c2: { fw: 'generic', board: 'proptroller' } };
    const c = firmwareChange(seen, {}, info('demo-lamp'))!;
    expect(c).toEqual({ from: { fw: 'generic', board: 'proptroller' }, to: { fw: 'demo-lamp', board: 'proptroller' }, typeChanged: true });
    expect(changeWords(c, 'Demo lamp').text).toBe("This board now runs Demo lamp. Its stored script and settings are from the previous firmware. Start fresh to load Demo lamp's defaults?");
    const p = firmwareChange(seen, {}, info('generic', 'lamp-board'))!;
    expect(p.typeChanged).toBe(false);
    expect(changeWords(p, 'Generic (stock)', 'Demo lamp board').text).toContain('now runs the board package Demo lamp board. Its stored script and settings are from the previous board package');
    // Keep mine: remembered for this board on exactly this firmware and package
    const kept = { [keptKey('a0b1c2', { fw: 'demo-lamp', board: 'proptroller' })]: true };
    expect(firmwareChange(seen, kept, info('demo-lamp'))).toBeNull();
    expect(firmwareChange(seen, kept, info('other-fw'))).not.toBeNull();
  });

  it('says what a board package\'s defaults hold', () => {
    expect(defaultsWords(undefined)).toBe('');
    expect(defaultsWords({ settings: 0, profile: false, script: false })).toBe('');
    expect(defaultsWords({ settings: 1, profile: false, script: true })).toBe('1 setting and an effect script');
    expect(defaultsWords({ settings: 3, profile: true, script: true })).toBe('3 settings, its own words for the terminals (a profile) and an effect script');
  });

  it('gives back the name and Wi-Fi with the password typed again, network and password together', () => {
    expect(keepValues({ name: 'Front door', ssid: 'Lab network', pass: 'typed' })).toEqual([
      { key: 'name', value: 'Front door' }, { key: 'wifi_ssid', value: 'Lab network' }, { key: 'wifi_pass', value: 'typed' }]);
    expect(keepValues({ name: 'Front door' })).toEqual([{ key: 'name', value: 'Front door' }]);
    expect(keepValues({})).toEqual([]);
    expect(freshWords('Front door', 'Generic (stock)', 'keep', true).text).toContain('Studio gives it back its name and Wi-Fi network');
    expect(freshWords('Front door', 'Generic (stock)').text).toContain('no longer on your Wi-Fi');
    // firmware that keeps them itself (factory_reset keep_wifi)
    expect(freshWords('Front door', 'Generic (stock)', 'keep', 'board').text).toContain('It keeps its name and its Wi-Fi network and password, and comes back on your network.');
  });

  it('asks about the new firmware\'s own script only when it has one, and names it', () => {
    expect(scriptQuestion(null, 'Demo lamp')).toBeNull();
    expect(scriptQuestion({ kind: 'defaults', source: 'none' }, 'Demo lamp')).toBeNull();
    expect(scriptQuestion({ kind: 'defaults', source: 'firmware', script: '  ' }, 'Demo lamp')).toBeNull();
    const q = scriptQuestion({ kind: 'defaults', source: 'board_package', script: 'effect lamp:\n', script_name: 'Lamp on when pressed' }, 'Demo lamp')!;
    expect(q.text).toBe("Demo lamp comes with its own script (“Lamp on when pressed”). Use it, or keep the script that's on the board now?");
    expect([q.use, q.keep, q.only]).toEqual(["Use Demo lamp's script", 'Keep my script', ['script']]);
    const p = scriptQuestion({ kind: 'defaults', source: 'firmware', script: 'x', profile: { aliases: [] } }, 'Demo lamp')!;
    expect(p.text).toContain('(its own script)');
    expect(p.only).toEqual(['script', 'profile']);
    expect(p.also).toContain('profile');
    expect(hasDefaultsOp({ capabilities: ['defaults'] })).toBe(true);
    expect(hasDefaultsOp({ capabilities: [] })).toBe(false);
  });
});

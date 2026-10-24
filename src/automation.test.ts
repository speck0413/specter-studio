import { describe, expect, it } from 'vitest';
import {
  NO_BRIDGE, Rule, bridgePrefs, bridgeStatusText, canSendAgain, countsText, paramSecretKey, fromExample, logTime, newRule, parseFilters, patternNames, removeRule,
  ruleSummary, secretLabel, stateSummary, updateRule, upsertRule, withoutSecrets,
} from './automation';

const rule = (p: Partial<Rule> = {}): Rule => ({ ...newRule(), ...p });

describe('automation rules in the UI', () => {
  it('a new rule is the check-in example, on, with its own id', () => {
    const a = newRule();
    const b = newRule();
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ enabled: true, method: 'POST', content_type: 'csv', pattern: 'checkin/*/{roomName}/complete', body: '{roomName},complete,{timestamp}' });
  });

  it('examples get fresh ids and start switched off, so they can be added twice', () => {
    const ex: Rule[] = [rule({ id: 'maze-start', enabled: true, headers: [{ name: 'X', value: 'y', secret: false }] })];
    const once = fromExample(ex);
    const twice = fromExample(ex);
    expect(once[0].id).not.toBe('maze-start');
    expect(once[0].id).not.toBe(twice[0].id);
    expect(once[0].enabled).toBe(false);
    once[0].headers[0].value = 'changed';
    expect(ex[0].headers[0].value).toBe('y');
  });

  it('editing the list: update, insert, replace, remove', () => {
    const a = rule({ id: 'a' });
    const b = rule({ id: 'b' });
    let list = upsertRule([a], b);
    expect(list.map((r) => r.id)).toEqual(['a', 'b']);
    list = upsertRule(list, { ...a, name: 'Check-in' });
    expect(list.map((r) => r.name)).toEqual(['Check-in', '']);
    list = updateRule(list, 'b', { enabled: false });
    expect(list[1].enabled).toBe(false);
    expect(removeRule(list, 'a').map((r) => r.id)).toEqual(['b']);
  });

  it('names in a pattern are the "for each" choices', () => {
    expect(patternNames('checkin/*/{roomName}/complete')).toEqual(['roomName']);
    expect(patternNames('/site/{site}/{roomName}/#')).toEqual(['site', 'roomName']);
    expect(patternNames('checkin/{}/x')).toEqual([]);
  });

  it('says what a rule does in plain words', () => {
    expect(ruleSummary(rule({ url: 'https://script.google.com/macros/s/abc/exec' }))).toBe('When a message arrives on checkin/*/{roomName}/complete, send a POST request to script.google.com.');
    expect(ruleSummary(rule({ url: '' }))).toContain('request to …');
    expect(stateSummary(rule({ count: { direction: 'up', name: 'inside', by: '', per: 'roomName' } }), { counts: { maze: 3, corn: 1 } })).toBe('Counts up inside for each roomName (now maze: 3, corn: 1)');
    expect(stateSummary(rule({ timer: { role: 'start', name: 'visit', per: 'roomName', pairing: 'latest' } }), { open_starts: { library: 2 } })).toBe('Starts timer visit (2 waiting to finish)');
    expect(stateSummary(rule())).toBe('');
    expect(countsText({ sent: 12, failed: 1, queued: 3, dropped: 2, limited: 4 })).toBe('Sent 12, failed 1, 3 waiting, 2 dropped (too many waiting), 4 skipped (too many a minute)');
    expect(countsText({ sent: 2, unsure: 1 })).toBe('Sent 2, 1 may have been sent (check the sheet)');
    expect(logTime('2026-10-24T21:04:05-05:00')).toBe('21:04:05');
  });

  it('secrets are only ever "set" or "not set", and never exported', () => {
    expect(secretLabel(true)).toBe('set');
    expect(secretLabel(false)).toBe('not set');
    expect(secretLabel(undefined)).toBe('not set');
    const r = withoutSecrets(rule({ headers: [{ name: 'Authorization', value: 'Bearer abc', secret: true }, { name: 'X-Room', value: '{roomName}', secret: false }] }));
    expect(JSON.stringify(r)).not.toContain('Bearer abc');
    expect(r.headers[1].value).toBe('{roomName}');
  });
});

describe('the connection to another server', () => {
  it('older saved settings send everything out; a password never stays in prefs', () => {
    const b = bridgePrefs({ on: true, host: 'broker.example.test', port: 1883, password: 'oops' });
    expect(b).toMatchObject({ on: true, direction: 'out', filters: ['#'] });
    expect('password' in b).toBe(false);
    expect(bridgePrefs(undefined)).toEqual(NO_BRIDGE);
    expect(bridgePrefs({ direction: 'sideways', filters: [' ', 'a/#'] })).toMatchObject({ direction: 'out', filters: ['a/#'] });
  });

  it('topic filters from a comma list', () => {
    expect(parseFilters('checkin/#, site/+/state\nother')).toEqual(['checkin/#', 'site/+/state', 'other']);
    expect(parseFilters('  ')).toEqual(['#']);
  });

  it('status in plain words', () => {
    expect(bridgeStatusText(null)).toBe('Not connected.');
    expect(bridgeStatusText({ state: 'connected', host: 'hq.example.test', sent: 4, received: 2 })).toBe('Connected to hq.example.test. 4 sent, 2 received.');
    expect(bridgeStatusText({ state: 'retrying', host: 'hq', last_error: 'Nothing answered at hq port 1883. Is the server running, and is the port right?', retry_in_s: 8, buffered: 3 }))
      .toBe('Not connected: Nothing answered at hq port 1883. Is the server running, and is the port right? Trying again in 8 s. Keeping the latest reports (3) until it is back.');
    expect(bridgeStatusText({ state: 'connecting', host: 'hq' })).toBe('Connecting to hq…');
  });
});

describe('sending again and the secret part of the address', () => {
  it('only entries with a request number offer "Send again"', () => {
    expect(canSendAgain({ at: 'x', ok: false, text: 'may have been sent: check the sheet (no answer)', resend: 7 })).toBe(true);
    expect(canSendAgain({ at: 'x', ok: false, text: 'not sent yet: could not connect; trying again in 2 s' })).toBe(false);
    expect(canSendAgain({ at: 'x', ok: true, text: 'sent (200)' })).toBe(false);
  });

  it('the address part is shown as set / not set under its own key, and exports keep only its name', () => {
    expect(paramSecretKey('checkin', 'key')).toBe('checkin:?key');
    const r = withoutSecrets(rule({ secret_param: 'key' }));
    expect(r.secret_param).toBe('key');
    expect(Object.keys(r)).not.toContain('value');
  });
});

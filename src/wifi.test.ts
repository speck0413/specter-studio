import { describe, expect, it } from 'vitest';
import { boardAddress, needsPassword, pickHint, scanStatus, signalBars, signalWords } from './wifi';

describe('Wi-Fi words', () => {
  it('says signal strength in bars and words, as the board page does', () => {
    expect([-48, -63, -75, -90].map(signalWords)).toEqual(['strong', 'good', 'weak', 'very weak']);
    expect(signalBars(-48)).toBe('▂▄▆█');
    expect(signalBars(-90)).toBe('▂');
  });

  it('says what the scan is doing', () => {
    expect(scanStatus(null)).toBe('Looking for networks…');
    expect(scanStatus({ scanning: true, networks: [] })).toBe('Looking for networks…');
    // a rescan too soon: the board says when it can look again (retry_ms)
    expect(scanStatus({ scanning: false, age_ms: 1090, retry_ms: 7410, networks: [{ ssid: 'Office', rssi: -48, secured: true }] }))
      .toBe('Looked 1 s ago; Rescan works again in 8 s.');
    expect(scanStatus({ networks: [{ ssid: 'Office', rssi: -48, secured: true }], age_ms: 90 })).toMatch(/^Networks this board can see, strongest first\. /);
    expect(scanStatus({ networks: [{ ssid: 'Office', rssi: -48, secured: true }], age_ms: 12_000 })).toContain('(12 s ago)');
    expect(scanStatus({ networks: [] })).toBe('The board sees no networks. Type the name, or Rescan.');
    expect(scanStatus({ networks: [], error: 'scan timed out' })).toContain('scan timed out');
  });

  it('after a pick says what to type next; an open network needs no password', () => {
    expect(pickHint({ ssid: 'Office', rssi: -48, secured: true }, false)).toContain('type the password of “Office”');
    expect(pickHint({ ssid: 'Guest Wi-Fi', rssi: -71, secured: false }, false)).toBe('“Guest Wi-Fi” is open (no password): leave Wi-Fi password empty, then Save settings.');
    // the network the board already has: an empty secret keeps its stored password (PROTOCOL.md set_params)
    expect(pickHint({ ssid: 'Guest Wi-Fi', rssi: -71, secured: false }, true)).toContain('still keeps a password for it from before');
  });

  it('a new network the board saw with a password is not saved without one', () => {
    const seen = [{ ssid: 'Office', rssi: -48, secured: true }, { ssid: 'Office', rssi: -80, secured: true }, { ssid: 'Guest Wi-Fi', rssi: -71, secured: false }];
    const saved = { wifi_ssid: 'Home', name: 'Front door' };
    expect(needsPassword({ wifi_ssid: 'Office' }, saved, seen)).toBe('Office');
    expect(needsPassword({ wifi_ssid: 'Office', wifi_pass: '' }, saved, seen)).toBe('Office');
    expect(needsPassword({ wifi_ssid: 'Office', wifi_pass: 'hunter22' }, saved, seen)).toBeNull();
    // an open network, one the board did not see, no network change, or no network at all: saved as typed
    expect(needsPassword({ wifi_ssid: 'Guest Wi-Fi' }, saved, seen)).toBeNull();
    expect(needsPassword({ wifi_ssid: 'Barn' }, saved, seen)).toBeNull();
    expect(needsPassword({ wifi_ssid: 'Office', name: 'x' }, { wifi_ssid: 'Office' }, seen)).toBeNull();
    expect(needsPassword({ name: 'x' }, saved, seen)).toBeNull();
    expect(needsPassword({ wifi_ssid: '' }, saved, seen)).toBeNull();
    expect(needsPassword({ wifi_ssid: 'Office' }, saved, [])).toBeNull();
  });

  it('finds the board by its name address (state.net.host), else its IP', () => {
    expect(boardAddress({ mode: 'sta', ip: '192.168.1.50', ssid: 'Office', host: 'proptroller.local', rssi: -58 }))
      .toEqual({ url: 'http://proptroller.local/', also: 'http://192.168.1.50/', on: 'Office' });
    expect(boardAddress({ mode: 'sta', ip: '192.168.1.50', ssid: 'Office' })).toEqual({ url: 'http://192.168.1.50/', on: 'Office' });
    expect(boardAddress({ mode: 'ap', ip: '192.168.4.1', ssid: 'Proptroller-AC2C' })).toEqual({ url: 'http://192.168.4.1/', on: 'Proptroller-AC2C' });
    expect(boardAddress({ mode: 'sim', ip: '127.0.0.1', ssid: '' })).toBeNull();
    expect(boardAddress({ mode: 'usb' })).toBeNull();
    expect(boardAddress(undefined)).toBeNull();
  });
});

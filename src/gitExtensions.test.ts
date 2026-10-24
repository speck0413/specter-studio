// An extension updated from git (components/GitExtensions.tsx) never gains permissions silently: consent is
// remembered for exactly what plugin.json asked for, from that folder, so an update that asks for more asks again.
import { describe, expect, it } from 'vitest';
import { fingerprint } from './components/pluginPerms';
import { needsConsent } from './components/PluginConsent';

const dir = '/config/extensions/demo-lights';
const before = { id: 'demo-lights', name: 'Demo lights', entry: 'index.html', dir, mqtt: { subscribe: ['demo/#'] } };

describe('extension updates and consent', () => {
  it('the same plugin.json after an update keeps the consent', () => {
    expect(fingerprint({ ...before })).toBe(fingerprint(before));
  });
  it('asking for more (control of boards, more topics, network) asks again', () => {
    const fp = fingerprint(before);
    expect(needsConsent(before)).toBe(true);
    expect(fingerprint({ ...before, control: true })).not.toBe(fp);
    expect(fingerprint({ ...before, mqtt: { subscribe: ['demo/#', 'other/#'] } })).not.toBe(fp);
    expect(fingerprint({ ...before, http: true })).not.toBe(fp);
  });
  it('a plugin that asked for nothing and now asks for control needs consent', () => {
    const plain = { id: 'demo-lights', entry: 'index.html', dir };
    expect(needsConsent(plain)).toBe(false);
    expect(needsConsent({ ...plain, control: true })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { aliasTargets, canPublish, canSubscribe, describePerms, fingerprint, isAction, perms, refusal } from './pluginPerms';

describe('plugin MQTT allowlist', () => {
  const p = perms({ mqtt: { subscribe: ['acme/+/status/#', 'acme/+/online'], publish: ['acme/+/config/get/+'], actions: ['acme/+/control/trigger', 'acme/+/config/set/remote_fire_enable'] } });
  it('subscribes only inside the declared filters', () => {
    expect(canSubscribe(p, 'acme/+/status/#')).toBe(true);
    expect(canSubscribe(p, 'acme/a1/status/ready')).toBe(true);
    expect(canSubscribe(p, 'acme/#')).toBe(false);
    expect(canSubscribe(p, 'proptroller/+/state')).toBe(false);
  });
  it('publishes only declared topics, never wildcards; actions are flagged', () => {
    expect(canPublish(p, 'acme/a1/config/get/runs_left')).toBe(true);
    expect(canPublish(p, 'acme/a1/control/trigger')).toBe(true);
    expect(isAction(p, 'acme/a1/control/trigger')).toBe(true);
    expect(isAction(p, 'acme/a1/config/get/x')).toBe(false);
    expect(canPublish(p, 'acme/a1/control/restart')).toBe(false);
    expect(canPublish(p, 'acme/+/control/trigger')).toBe(false);
  });
  it('the short form and the consent words', () => {
    const s = perms({ mqtt: ['demolamp/#'], http: true });
    expect(canPublish(s, 'demolamp/x/cmd') && canSubscribe(s, 'demolamp/+/status')).toBe(true);
    expect(describePerms(s)).toEqual(['Read messages on: demolamp/#', 'Send messages on: demolamp/#', 'Talk to devices on this network']);
  });
});

describe('plugin board requests', () => {
  const read = perms({});
  const ctl = perms({ control: true });
  const keys = ['volume', 'out1_soft_start_ms', 'out1_max_on_ms', 'name', 'trig2', 'interlock_relays', 'wifi_ssid', 'page_lock'];
  it('without "control" a plugin only reads', () => {
    expect(refusal({ op: 'state' }, read)).toBeNull();
    expect(refusal({ op: 'get_params' }, read)).toBeNull();
    for (const op of ['run', 'pause', 'stop_all', 'set_output', 'set_params', 'sound', 'pixel', 'cue'])
      expect(refusal({ op, values: [{ key: 'volume', value: 3 }] }, read, keys)).toMatch(/control/);
  });
  it('never profiles, passwords, restarts, scripts or firmware, even with "control"', () => {
    for (const op of ['set_profile', 'reboot', 'factory_reset', 'put_backup', 'set_script', 'set_show', 'put_show', 'delete_show', 'custom'])
      expect(refusal({ op }, ctl, keys)).toMatch(/not available/);
  });
  it('settings: only a key the board lists, never identity, access, network, limits or roles; aliases refused', () => {
    expect(refusal({ op: 'set_params', values: [{ key: 'volume', value: 3 }] }, ctl, keys)).toBeNull();
    expect(refusal({ op: 'set_params', values: [{ key: 'out1_soft_start_ms', value: 30 }] }, ctl, keys)).toBeNull();
    for (const k of ['name', 'wifi_ssid', 'page_lock', 'pin', 'out1_max_on_ms', 'interlock_relays', 'trig2', 'mqtt_broker', 'mqtt_port', 'rly1_role'])
      expect(refusal({ op: 'set_params', values: [{ key: k, value: 1 }] }, ctl, keys)).toMatch(/cannot change/);
    // label_text is a profile alias of name: not a key the board lists
    expect(refusal({ op: 'set_params', values: [{ key: 'label_text', value: 'x' }] }, ctl, keys)).toMatch(/cannot change|not a setting/);
    expect(refusal({ op: 'set_params', values: [{ key: 'loudness', value: 1 }] }, ctl, keys)).toMatch(/not a setting/);
    expect(refusal({ op: 'set_params', values: [{ key: 'volume', value: 1 }, { key: 'name', value: 'x' }] }, ctl, keys)).toMatch(/cannot change name/);
  });
  it('consent is remembered for exactly what was asked for, from that folder', () => {
    const a = { id: 'p', dir: '/x/p', mqtt: ['a/#'] };
    expect(fingerprint(a)).toBe(fingerprint({ ...a }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, mqtt: ['#'] }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, http: true }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, control: true }));
    expect(fingerprint(a)).not.toBe(fingerprint({ ...a, dir: '/y/p' }));
    expect(describePerms(perms({ control: true }))[0]).toMatch(/^Control boards/);
  });
});

describe('settings under a profile\'s names', () => {
  it('a setting plugins may not change stays closed under its alias; others go by the name the board lists', () => {
    const p = perms({ control: true });
    // with a profile, get_params lists the alias as the key
    const keys = ['lamp_time', 'allow_remote', 'net_name', 'out2_on_ms'];
    const aliasOf = aliasTargets({ aliases: [
      { alias: 'lamp_time', key: 'out1_on_ms' }, { alias: 'allow_remote', key: 'remote_trigger_enable' },
      { alias: 'net_name', key: 'wifi_ssid' }, { alias: 'go', control: 'trigger' }] });
    expect(aliasOf).toEqual({ lamp_time: 'out1_on_ms', allow_remote: 'remote_trigger_enable', net_name: 'wifi_ssid' });
    const set = (key: string) => refusal({ op: 'set_params', values: [{ key, value: 1 }] }, p, keys, aliasOf);
    expect(set('lamp_time')).toBeNull();
    expect(set('out2_on_ms')).toBeNull();
    expect(set('allow_remote')).toBe('plugins cannot change allow_remote');
    expect(set('net_name')).toBe('plugins cannot change net_name');
    // the setting's own name is not what the board lists while the profile is loaded
    expect(set('out1_on_ms')).toBe('out1_on_ms is not a setting of this board');
  });
});


import { describe as group, expect, it } from 'vitest';
import { describe, logLine, SOUND_SILENT } from './store';
import { fileStampLocal } from './api';

group('activity lines say what the event carries (bench run 2026-10-22)', () => {
  it('a watchdog or interlock notice names the output', () => {
    expect(describe({ event: 'notice', data: { notice: 'watchdog', channel: 'OUT1' } })).toBe('OUT1 was switched off: it reached its max on-time (watchdog)');
    expect(describe({ event: 'notice', data: { notice: 'interlock', channel: 'RLY2' } })).toBe('RLY2 was held off by an interlock');
  });
  it('the pause notice is said only when it is released (stopping is said from the state)', () => {
    expect(describe({ event: 'notice', data: { notice: 'paused', paused: true } })).toBeNull();
    expect(describe({ event: 'notice', data: { notice: 'paused', paused: false } })).toBe('Resumed: shows start on their triggers again');
  });
});

group('a board with no sound player', () => {
  it('says so once in plain words, not twice after every stop', () => {
    let b: { soundQuiet?: boolean } = {};
    const lines: string[] = [];
    for (const t of ['sound player did not answer command 0x16', 'sound player did not answer command 0x16', 'Show 1 started (api)', 'sound player did not answer command 0x0e']) {
      const l = logLine(b, t);
      if (l.soundQuiet !== undefined) b = { soundQuiet: l.soundQuiet };
      if (l.text) lines.push(l.text);
    }
    expect(lines).toEqual([SOUND_SILENT, 'Show 1 started (api)']);
  });
  it('says it again after the player answered once and went quiet', () => {
    expect(logLine({ soundQuiet: true }, 'sound player online')).toEqual({ text: 'sound player online', soundQuiet: false });
    expect(logLine({ soundQuiet: false }, 'sound player did not answer command 0x16').text).toBe(SOUND_SILENT);
  });
});

group('backup file names', () => {
  it('use the local time, as the backup list shows it', () => {
    expect(fileStampLocal(new Date(2026, 9, 22, 13, 4, 5))).toBe('2026-10-22-130405');
  });
});

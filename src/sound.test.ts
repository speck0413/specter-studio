import { describe, expect, it } from 'vitest';
import { hasSound, soundChoices, soundLabel, soundName, soundNow, soundRequest } from './sound';

describe('the sound tile', () => {
  it('shows on boards with a sound player', () => {
    expect(hasSound({ info: { terminals: [{ id: 'SOUND' }] } } as any)).toBe(true);
    expect(hasSound({ info: { capabilities: ['sound'] } } as any)).toBe(true);
    expect(hasSound({ info: { terminals: [{ id: 'OUT1' }], capabilities: [] } } as any)).toBe(false);
    expect(hasSound(undefined)).toBe(false);
  });
  it('names sounds the way a beginner reads them, one per number', () => {
    expect(soundName('0003-door_creak.mp3')).toBe('door creak');
    expect(soundName('scream.mp3')).toBe('scream');
    expect(soundName('7.mp3')).toBe('7');
    expect(soundChoices({ 'b.mp3': 2, 'a.mp3': 1, 'again.mp3': 1, 'big.mp3': 3001 })).toEqual([{ n: 1, name: 'a' }, { n: 2, name: 'b' }]);
    expect(soundChoices(undefined)).toEqual([]);
    expect(soundLabel(1, { 'rain.mp3': 1 })).toBe('sound 1 · rain');
    expect(soundLabel(5, { 'rain.mp3': 1 })).toBe('sound 5');
  });
  it('asks the board for sound N in the card\'s mp3 folder, kept in range', () => {
    expect(soundRequest.once(3)).toEqual({ op: 'sound', cmd: 'play_mp3', track: 3 });
    expect(soundRequest.repeat(0)).toEqual({ op: 'sound', cmd: 'loop_mp3', track: 1 });
    expect(soundRequest.once(5000)).toEqual({ op: 'sound', cmd: 'play_mp3', track: 3000 });
    expect(soundRequest.volume(44)).toEqual({ op: 'sound', cmd: 'volume', volume: 30 });
    expect(soundRequest.stop()).toEqual({ op: 'sound', cmd: 'stop' });
  });
  it('says what plays now, as "sound 3 · description" when the card list has it', () => {
    const sounds = { 'scream.mp3': 3 };
    expect(soundNow({ sound: { playing: true, track: '/mp3/0003', source: 'show', online: true } }, sounds).text).toBe('Playing sound 3 · scream.');
    expect(soundNow({ sound: { playing: true, track: '/mp3/0003 (loop)', source: 'ambient', online: true } }, sounds).text).toBe('Playing sound 3 · scream on repeat, started by the background loop.');
    expect(soundNow({ sound: { playing: true, track: '/mp3/0004', online: true } }).text).toBe('Playing sound 4.');
    expect(soundNow({ sound: { playing: true, track: 'card file #7', online: true } }).text).toBe('Playing card file 7.');
    expect(soundNow({ sound: { playing: true, track: '/02/005', online: true } }).text).toBe('Playing folder 2, track 5.');
    expect(soundNow({ sound: { playing: false, online: true } }).text).toBe('Nothing playing.');
    expect(soundNow({ sound: { playing: false, online: false } }).online).toBe(false);
    // older firmware: flat fields
    expect(soundNow({ sound_playing: true, sound_online: true }).text).toBe('Playing a sound.');
  });
});

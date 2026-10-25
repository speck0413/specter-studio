import { describe, expect, it } from 'vitest';
import { cardName, descriptionOf, mapCsv, mapText, move, parseCardName, parseSoundsCsv, soundLabel, soundNumbers, soundsCsv, SOUND_FOLDERS_MAX, CARD_MAX_BYTES } from './list';

describe('card names into "3 · scream" hints', () => {
  it('reads the folder number and the description', () => {
    expect(parseCardName('03/001-scream.mp3')).toEqual({ number: 3, description: 'scream', ext: 'mp3' });
    expect(parseCardName('10/001.wav')).toEqual({ number: 10, description: '', ext: 'wav' });
    expect(parseCardName('02/001_door creak.MP3')).toEqual({ number: 2, description: 'door creak', ext: 'mp3' });
    expect(parseCardName('04\\scream.mp3')).toEqual({ number: 4, description: 'scream', ext: 'mp3' });
    expect(parseCardName('001-scream.mp3')).toBeNull();
    expect(parseCardName('mp3/0001-x.mp3')).toBeNull();
    expect(parseCardName('00/001-x.mp3')).toBeNull();
    expect(parseCardName('100/001-x.mp3')).toBeNull();
  });
  it('lists sounds by number, skipping hidden Mac files and other formats', () => {
    const s = soundNumbers(['03/001-scream.mp3', '01/._001-rain.mp3', '01/001-rain.mp3', '02/cover.jpg', '02/001-elevator.wav', 'loose.mp3', '03/001-again.mp3']);
    expect(s).toEqual([{ number: 1, description: 'rain' }, { number: 2, description: 'elevator' }, { number: 3, description: 'scream' }]);
    expect(s.map(soundLabel)).toEqual(['1 · rain', '2 · elevator', '3 · scream']);
    expect(soundLabel({ number: 7, description: '' })).toBe('7');
  });
});

describe('the map as text', () => {
  const rows = [{ number: 1, name: '01/001-rain.mp3' }, { number: 2, name: '02/001-a, "b".mp3' }];
  it('copies as plain lines and saves as CSV', () => {
    expect(mapText(rows)).toBe('1  01/001-rain.mp3\n2  02/001-a, "b".mp3\n');
    expect(mapCsv(rows)).toBe('number,file\n1,01/001-rain.mp3\n2,"02/001-a, ""b"".mp3"\n');
    expect(mapCsv([])).toBe('number,file\n');
  });
  it('keeps sounds.csv with the library and reads it back', () => {
    const csv = soundsCsv([{ number: 1, file: 'rain.mp3' }, { number: 2, file: 'a, "b".wav' }]);
    expect(csv).toBe('number,file\n1,rain.mp3\n2,"a, ""b"".wav"\n');
    expect(parseSoundsCsv('number,description,file\n3,scream,03/001-scream.mp3\n')).toEqual([{ number: 3, description: 'scream' }]);
    expect(parseSoundsCsv(csv)).toEqual([{ number: 1, description: 'rain' }, { number: 2, description: 'a, "b"' }]);
    expect(parseSoundsCsv(mapCsv(rows))).toEqual([{ number: 1, description: 'rain' }, { number: 2, description: 'a, "b"' }]);
    expect(parseSoundsCsv('')).toEqual([]);
  });
});

describe('the sound list', () => {
  it('names files as the core does', () => {
    expect(cardName(1, 'rain', 'mp3')).toBe('01/001-rain.mp3');
    expect(cardName(3, 'scream: loud?', 'WAV')).toBe('03/001-scream loud.wav');
    expect(cardName(4, '...', 'mp3')).toBe('04/001.mp3');
    expect(cardName(99, 'x', 'mp3')).toBe('99/001-x.mp3');
    // FAT's 255 characters are per name: the file part
    const long = cardName(5, 'x'.repeat(400), 'mp3');
    expect(long.startsWith('05/001-x')).toBe(true);
    expect(long.slice(3).length).toBe(255);
    expect(parseCardName(cardName(7, 'door creak', 'wav'))).toEqual({ number: 7, description: 'door creak', ext: 'wav' });
    expect(descriptionOf('/media/sd/sounds/door creak.mp3')).toBe('door creak');
    expect(descriptionOf('C:\\Sounds\\rain.wav')).toBe('rain');
  });
  it('moves an item up or down', () => {
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
  it('has the limits the core has', () => {
    expect(SOUND_FOLDERS_MAX).toBe(99);
    expect(CARD_MAX_BYTES).toBe(68_719_476_736);
  });
});

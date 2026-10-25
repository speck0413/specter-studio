import { describe, expect, it } from 'vitest';
import { cardName, descriptionOf, mapCsv, mapText, move, parseCardName, parseSoundsCsv, soundLabel, soundNumbers, soundsCsv, MP3_FOLDER_MAX, CARD_MAX_BYTES } from './list';

describe('card names into "3 · scream" hints', () => {
  it('reads the 4-digit number and the description', () => {
    expect(parseCardName('0003-scream.mp3')).toEqual({ number: 3, description: 'scream', ext: 'mp3' });
    expect(parseCardName('0010.wav')).toEqual({ number: 10, description: '', ext: 'wav' });
    expect(parseCardName('0002_door creak.MP3')).toEqual({ number: 2, description: 'door creak', ext: 'mp3' });
    expect(parseCardName('scream.mp3')).toBeNull();
    expect(parseCardName('12-x.mp3')).toBeNull();
  });
  it('lists sounds by number, skipping hidden Mac files and other formats', () => {
    const s = soundNumbers(['0003-scream.mp3', '._0001-rain.mp3', '0001-rain.mp3', 'cover.jpg', '0002-elevator.wav', 'loose.mp3', '0003-again.mp3']);
    expect(s).toEqual([{ number: 1, description: 'rain' }, { number: 2, description: 'elevator' }, { number: 3, description: 'scream' }]);
    expect(s.map(soundLabel)).toEqual(['1 · rain', '2 · elevator', '3 · scream']);
    expect(soundLabel({ number: 7, description: '' })).toBe('7');
  });
});

describe('the map as text', () => {
  const rows = [{ number: 1, name: '0001-rain.mp3' }, { number: 2, name: '0002-a, "b".mp3' }];
  it('copies as plain lines and saves as CSV', () => {
    expect(mapText(rows)).toBe('1  0001-rain.mp3\n2  0002-a, "b".mp3\n');
    expect(mapCsv(rows)).toBe('number,file\n1,0001-rain.mp3\n2,"0002-a, ""b"".mp3"\n');
    expect(mapCsv([])).toBe('number,file\n');
  });
  it('keeps sounds.csv with the library and reads it back', () => {
    const csv = soundsCsv([{ number: 1, file: 'rain.mp3' }, { number: 2, file: 'a, "b".wav' }]);
    expect(csv).toBe('number,file\n1,rain.mp3\n2,"a, ""b"".wav"\n');
    expect(parseSoundsCsv('number,description,file\n3,scream,0003-scream.mp3\n')).toEqual([{ number: 3, description: 'scream' }]);
    expect(parseSoundsCsv(csv)).toEqual([{ number: 1, description: 'rain' }, { number: 2, description: 'a, "b"' }]);
    expect(parseSoundsCsv(mapCsv(rows))).toEqual([{ number: 1, description: 'rain' }, { number: 2, description: 'a, "b"' }]);
    expect(parseSoundsCsv('')).toEqual([]);
  });
});

describe('the sound list', () => {
  it('names files as the core does', () => {
    expect(cardName(1, 'rain', 'mp3')).toBe('0001-rain.mp3');
    expect(cardName(3, 'scream: loud?', 'WAV')).toBe('0003-scream loud.wav');
    expect(cardName(4, '...', 'mp3')).toBe('0004.mp3');
    expect(cardName(5, 'x'.repeat(400), 'mp3').length).toBe(255);
    expect(descriptionOf('/home/me/sounds/door creak.mp3')).toBe('door creak');
    expect(descriptionOf('C:\\Sounds\\rain.wav')).toBe('rain');
  });
  it('moves an item up or down', () => {
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
  it('has the limits the core has', () => {
    expect(MP3_FOLDER_MAX).toBe(3000);
    expect(CARD_MAX_BYTES).toBe(68_719_476_736);
  });
});

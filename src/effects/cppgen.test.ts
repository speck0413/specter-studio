/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { duration, effectName, scriptToCpp } from './cppgen';

const EX = path.resolve(__dirname, '../../firmware/firmware/show-script-examples');

describe('effect script to C++', () => {
  it('times', () => {
    expect(duration('2.5')).toBe('seconds(2.5)');
    expect(duration('200 ms')).toBe('milliseconds(200)');
    expect(duration('3 min')).toBe('minutes(3)');
    expect(duration('soon')).toBeNull();
  });

  it('wait lines and audio_volume', () => {
    const cpp = scriptToCpp('effect a:\n  wait for trig1\n  audio_volume = 60%\n  audio_single = 2\n  wait for 2 s\n  audio_volume = off\n');
    expect(cpp).toContain('.setVolume(18)');
    expect(cpp).toContain('.playSound(2)');
    expect(cpp).toContain('.wait(seconds(2))');
    expect(cpp).toContain('.setVolume(0)');
  });

  it('a tell line has no step in the beginner layer: it stays as a comment', () => {
    const cpp = scriptToCpp('effect a:\n  wait for trig1\n  tell porch blackout\n  tell all pixel_speed = 150\n  out1 = on\n');
    expect(cpp).toContain('// not available in the C++ beginner layer: tell porch blackout');
    expect(cpp).toContain('// not available in the C++ beginner layer: tell all pixel_speed = 150');
    expect(cpp).toContain('.turnOn(OUT1)');
  });

  it('the light-up ghost', () => {
    const cpp = scriptToCpp(fs.readFileSync(path.join(EX, '01_light_up_ghost.txt'), 'utf8'));
    expect(cpp).toContain(
      '  prop.when(TRIG1)\n      .fadeTo(OUT1, percent(100), seconds(1.5)).wait(seconds(1.5))\n      .wait(seconds(6))\n      .fadeTo(OUT1, percent(0), seconds(3)).wait(seconds(3))\n      .wait(seconds(20));',
    );
    expect(cpp).toMatch(/#include <Proptroller.h>[\s\S]*void setup\(\) \{\n  prop.begin\(\);[\s\S]*void loop\(\) \{\n  prop.update\(\);\n\}/);
  });

  it('the flickering lamp keeps what C++ cannot do as a comment', () => {
    const cpp = scriptToCpp(fs.readFileSync(path.join(EX, '03_flickering_lamp.txt'), 'utf8'));
    expect(cpp).toContain('prop.when(TRIG2)\n      .dim(OUT3, percent(70))\n      .playSound(1)\n      // not available in the C++ beginner layer: flicker out3 for 4\n      .dim(OUT3, percent(70))');
  });

  it('relays, contacts and a trailing comment line', () => {
    const cpp = scriptToCpp('effect knock:\n  wait for trig2\n  rly1 = on\n  sleep 3\n  rly1 = off\n  dmx1 = on\n');
    expect(cpp).toContain('prop.when(TRIG2)\n      .turnOn(RLY1)\n      .wait(seconds(3))\n      .turnOff(RLY1)\n      // not available in the C++ beginner layer: dmx1 = on\n      ;');
    expect(scriptToCpp('effect x:\n  out1 = on\n')).toContain('has no "wait for" line');
  });

  it('the rainy porch: lines above the first wait for and an effect with no wait for stay as comments', () => {
    const cpp = scriptToCpp(fs.readFileSync(path.join(EX, '10_rainy_porch.txt'), 'utf8'));
    expect(cpp).toContain('// not available in the C++ beginner layer (above the first wait for): audio_loop = 1');
    expect(cpp).toContain('// not available in the C++ beginner layer (above the first wait for): out1 = 15%');
    expect(cpp).toContain('.playSound(2)\n      .turnOn(OUT1)\n      .wait(seconds(4))');
    expect(cpp).toContain('  // effect candle\n  // this effect has no "wait for" line: on the board it goes round and round from power-on');
  });

  it('reads effect headers as the board does', () => {
    expect(effectName('effect1:')).toBe('effect1');
    expect(effectName('effect Big   Scary  Ghost:')).toBe('big scary ghost');
    expect(effectName('effect:')).toBe('');
    const cpp = scriptToCpp('effect1:\nwait for trig1\neffect Big   Scary  Ghost:\nwait for trig2\n');
    expect(cpp).toContain('  // effect effect1\n  prop.when(TRIG1);');
    expect(cpp).toContain('  // effect big scary ghost\n  prop.when(TRIG2);');
  });
});

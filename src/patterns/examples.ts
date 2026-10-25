// Example patterns, written for Specter Studio (MIT, like the rest of Studio). Never add patterns copied from
// elsewhere unless their licence allows it and is kept with them.

export const STARTER_PATTERN = `// A rainbow that moves along the strip.
// render(index) runs once for every light and gives it a colour with hsv(hue, saturation, brightness).

export var speed = 0.5

// a slider under the preview (0 to 1)
export function sliderSpeed(v) {
  speed = v
}

var t
export function beforeRender(delta) {
  // time(x) goes from 0 to 1 again and again; a bigger x is slower
  t = time(0.2 * (1.05 - speed))
}

export function render(index) {
  hsv(t + index / pixelCount, 1, 1)
}
`;

export const EXAMPLE_PATTERNS: { title: string; text: string }[] = [
  { title: 'rainbow', text: STARTER_PATTERN },
  {
    title: 'breathing glow',
    text: `// The whole strip slowly glows brighter and dimmer in one colour.

var hue = 0.08, sat = 1
export function hsvPickerColor(h, s, v) {
  hue = h
  sat = s
}

var level
export function beforeRender(delta) {
  level = wave(time(0.06))
}

export function render(index) {
  hsv(hue, sat, level * level)
}
`,
  },
  {
    title: 'comet',
    text: `// A bright dot runs along the strip and leaves a fading tail.

var trail = array(pixelCount)
var pos = 0
export var tail = 0.85

export function sliderTail(v) {
  tail = 0.5 + v * 0.45
}

export function beforeRender(delta) {
  pos = (pos + delta / 30) % pixelCount
  trail.mutate((v) => v * tail)
  trail[floor(pos)] = 1
}

export function render(index) {
  hsv(0.6, 0.8, trail[index])
}
`,
  },
  {
    title: 'candle flicker',
    text: `// Warm light that flickers at random, like a candle or a failing bulb.

var lights = array(pixelCount)

export function beforeRender(delta) {
  for (var i = 0; i < pixelCount; i++) {
    if (random(1) < 0.1) lights[i] = 0.4 + random(0.6)
  }
}

export function render(index) {
  hsv(0.07, 0.9, lights[index])
}
`,
  },
  {
    title: 'clue puzzle',
    text: `// A puzzle board: the strip is red until it is solved. Each clue lights its own stretch yellow, in any order,
// and when every clue is solved the whole strip turns green. A show script presses the buttons:
//   effect puzzle:
//     pixels = pattern clue puzzle
//   effect clue1:
//     wait for trig1
//     pixels press clue1
var first = [0, 10, 20, 30, 40, 50]   // first light of each clue (0 = the first light)
var last  = [9, 19, 29, 39, 49, 59]   // last light of each clue
var solved = array(6)
var all = 0

export function triggerClue1() { solved[0] = 1 }
export function triggerClue2() { solved[1] = 1 }
export function triggerClue3() { solved[2] = 1 }
export function triggerClue4() { solved[3] = 1 }
export function triggerClue5() { solved[4] = 1 }
export function triggerClue6() { solved[5] = 1 }
export function triggerReset() { for (var i = 0; i < 6; i++) solved[i] = 0 }

export function beforeRender(delta) {
  all = solved.sum() == 6
}

export function render(index) {
  if (all) { rgb(0, 1, 0); return }
  for (var c = 0; c < 6; c++) {
    if (solved[c] && index >= first[c] && index <= last[c]) { rgb(1, 1, 0); return }
  }
  rgb(1, 0, 0)
}
`,
  },
];


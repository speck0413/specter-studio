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
];

// The icons an effect script can name (`# icon: skull`, look.ts) and the colours (`# color: red` or `#c00000`).
// Built in: plain 24 x 24 shapes. lightning, fog, bulb, speaker, fire, star, bell, play, eye, door and drop are
// the Material icons' paths (@mui/icons-material, MIT, already in Studio); splat, skull, ghost, bat and spider are
// drawn here. Extensions add more (plugin.json "icons", sanitized SVG, svg.ts); they never replace a built-in.
// An icon is drawn as a disc in its colour with the shape in black or white, whichever reads on that colour,
// and a thin outline, so a white or yellow icon still shows on every theme. It always carries its name (a label
// for screen readers and a tooltip), so the colour is never the only thing that tells two apart.
import React, { useSyncExternalStore } from 'react';
import { Box, Tooltip } from '@mui/material';
import { call } from '../api';
import { sanitizeSvg } from './svg';

export interface IconDef { label: string; color: string; paths: { d: string; stroke?: boolean }[] }

const dot = (x: number, y: number, r: number) => `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

/** The built-in icons by the name a script uses, in the picker's order. */
export const BUILTIN_ICONS: Record<string, IconDef> = {
  play: { label: 'Play', color: 'blue', paths: [{ d: 'M8 5v14l11-7z' }] },
  splat: { label: 'Splat', color: 'red', paths: [{ d: 'M12 4.2C12.7 4.2 13.1 7.6 14.3 7.7C15.5 7.8 18.4 4.3 18.7 4.8C19.1 5.3 16.3 9.2 16.3 10.7C16.3 12.1 18.6 12.3 18.7 12.9C18.8 13.5 16.9 13 17 14.2C17.2 15.4 20 19.2 19.4 19.7C18.7 20.1 14.9 17 13.6 16.8C12.4 16.6 13.1 18.5 12.4 18.6C11.7 18.7 11 17.3 9.7 17.4C8.4 17.4 5.6 19.4 5.2 18.8C4.9 18.3 7.9 15.6 7.8 14.3C7.6 13.1 4.7 12.5 4.6 11.8C4.5 11.1 6.6 10.9 7.1 10.3C7.7 9.7 7.2 8.8 7.7 8.3C8.3 7.9 9.6 8.4 10.4 7.7C11.1 6.9 11.3 4.2 12 4.2zM20 5.2a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0 -2.2 0zM17.3 21.6a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0 -2.4 0zM1.9 18.5a1.0 1.0 0 1 0 2 0a1.0 1.0 0 1 0 -2 0zM13.1 1.3a0.8 0.8 0 1 0 1.6 0a0.8 0.8 0 1 0 -1.6 0zM1.2 9.8a0.9 0.9 0 1 0 1.8 0a0.9 0.9 0 1 0 -1.8 0z' }] },
  drop: { label: 'Drop', color: 'red', paths: [{ d: 'M12 2c-5.33 4.55-8 8.48-8 11.8 0 4.98 3.8 8.2 8 8.2s8-3.22 8-8.2c0-3.32-2.67-7.25-8-11.8M7.83 14c.37 0 .67.26.74.62.41 2.22 2.28 2.98 3.64 2.87.43-.02.79.32.79.75 0 .4-.32.73-.72.75-2.13.13-4.62-1.09-5.19-4.12-.08-.45.28-.87.74-.87' }] },
  lightning: { label: 'Lightning', color: 'yellow', paths: [{ d: 'M11 21h-1l1-7H7.5c-.58 0-.57-.32-.38-.66s.05-.08.07-.12C8.48 10.94 10.42 7.54 13 3h1l-1 7h3.5c.49 0 .56.33.47.51l-.07.15C12.96 17.55 11 21 11 21' }] },
  fog: { label: 'Fog', color: 'grey', paths: [{ d: 'M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96' }] },
  bulb: { label: 'Light bulb', color: 'yellow', paths: [{ d: 'M9 21c0 .5.4 1 1 1h4c.6 0 1-.5 1-1v-1H9zm3-19C8.1 2 5 5.1 5 9c0 2.4 1.2 4.5 3 5.7V17c0 .5.4 1 1 1h6c.6 0 1-.5 1-1v-2.3c1.8-1.3 3-3.4 3-5.7 0-3.9-3.1-7-7-7' }] },
  sound: { label: 'Sound', color: 'teal', paths: [{ d: 'M3 9v6h4l5 5V4L7 9zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77' }] },
  skull: { label: 'Skull', color: 'white', paths: [{ d: 'M12 2C7 2 4 5.5 4 9.6c0 2.4 1 4.2 2.5 5.3V18c0 .6.4 1 1 1H9v2h2v-2h2v2h2v-2h1.5c.6 0 1-.4 1-1v-3.1C19 13.8 20 12 20 9.6 20 5.5 17 2 12 2z' + dot(8.8, 10.6, 2) + dot(15.2, 10.6, 2) + 'M12 13.2l-1.3 2.3h2.6z' }] },
  ghost: { label: 'Ghost', color: 'white', paths: [{ d: 'M12 2C7.6 2 5 5.2 5 9.5V22l2.3-2 2.3 2 2.4-2 2.4 2 2.3-2 2.3 2V9.5C19 5.2 16.4 2 12 2z' + dot(9.5, 10, 1.5) + dot(14.5, 10, 1.5) + dot(12, 14.5, 1.2) }] },
  bat: { label: 'Bat', color: 'purple', paths: [{ d: 'M12 8.5c-.6 0-1 .4-1.2.9L10.3 8l-.5 2.1C8.6 8.6 6 7.6 2 8c1.6 1 2.3 2.6 2 4.3 1.2-.6 2.6-.5 3.5.4.4-1 1.6-1.6 2.7-1.2L12 16l1.8-4.5c1.1-.4 2.3.2 2.7 1.2.9-.9 2.3-1 3.5-.4-.3-1.7.4-3.3 2-4.3-4-.4-6.6.6-7.8 2.1L13.7 8l-.5 1.4c-.2-.5-.6-.9-1.2-.9z' }] },
  spider: { label: 'Spider', color: 'purple', paths: [
    { d: dot(12, 14.5, 3.2) + dot(12, 9.6, 2) },
    { d: 'M12 7.6V2M9.6 12.6 6 9.5 4.5 5M9.2 14 5 13 2.5 9.5M9.3 15.6 5.2 17.2 3.2 20.5M10.2 17.2 8 20 7 22.5M14.4 12.6 18 9.5l1.5-4.5M14.8 14l4.2-1 2.5-3.5M14.7 15.6l4.1 1.6 2 3.3M13.8 17.2 16 20l1 2.5', stroke: true },
  ] },
  fire: { label: 'Fire', color: 'orange', paths: [
    { d: 'm12 12.9-2.13 2.09c-.56.56-.87 1.29-.87 2.07C9 18.68 10.35 20 12 20s3-1.32 3-2.94c0-.78-.31-1.52-.87-2.07z' },
    { d: 'm16 6-.44.55C14.38 8.02 12 7.19 12 5.3V2S4 6 4 13c0 2.92 1.56 5.47 3.89 6.86-.56-.79-.89-1.76-.89-2.8 0-1.32.52-2.56 1.47-3.5L12 10.1l3.53 3.47c.95.93 1.47 2.17 1.47 3.5 0 1.02-.31 1.96-.85 2.75 1.89-1.15 3.29-3.06 3.71-5.3.66-3.55-1.07-6.9-3.86-8.52' },
  ] },
  eye: { label: 'Eye', color: 'green', paths: [{ d: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3' }] },
  door: { label: 'Door', color: 'orange', paths: [{ d: 'M19 19V5c0-1.1-.9-2-2-2H7c-1.1 0-2 .9-2 2v14H3v2h18v-2zm-4-6h-2v-2h2z' }] },
  star: { label: 'Star', color: 'yellow', paths: [{ d: 'M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z' }] },
  bell: { label: 'Bell', color: 'yellow', paths: [{ d: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2m6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1z' }] },
};

/** Other words people may write for a built-in icon. */
const ALIASES: Record<string, string> = { blood: 'splat', bolt: 'lightning', cloud: 'fog', smoke: 'fog', light: 'bulb', lamp: 'bulb', lightbulb: 'bulb', speaker: 'sound', audio: 'sound', flame: 'fire', water: 'drop' };

/** The colours a script can name, as shown on every theme (the disc's outline keeps white and yellow visible). */
export const COLORS: Record<string, { label: string; hex: string }> = {
  red: { label: 'Red', hex: '#d32f2f' },
  orange: { label: 'Orange', hex: '#ef6c00' },
  yellow: { label: 'Yellow', hex: '#fbc02d' },
  green: { label: 'Green', hex: '#2e7d32' },
  teal: { label: 'Teal', hex: '#00897b' },
  blue: { label: 'Blue', hex: '#1e88e5' },
  purple: { label: 'Purple', hex: '#7b1fa2' },
  pink: { label: 'Pink', hex: '#d81b60' },
  white: { label: 'White', hex: '#f5f5f5' },
  grey: { label: 'Grey', hex: '#757575' },
  black: { label: 'Black', hex: '#212121' },
};
const COLOR_ALIASES: Record<string, string> = { gray: 'grey', violet: 'purple', amber: 'yellow', gold: 'yellow', crimson: 'red', blood: 'red', cyan: 'teal', magenta: 'pink' };

// ---------------------------------------------------------------- icons from extensions

export interface ExtIcon { name: string; label: string; svg: string; from: string }
export interface ExtIcons { icons: Record<string, ExtIcon>; logos: Record<string, string> }
let ext: ExtIcons = { icons: {}, logos: {} };
let extVersion = 0;
const listeners = new Set<() => void>();

/** The icons and extension logos from `plugin_icons` (core plugins.rs), sanitized; built-in names are never
 * replaced, and the first extension to name an icon keeps it. */
export function extIconsFrom(list: any[]): ExtIcons {
  const out: ExtIcons = { icons: {}, logos: {} };
  for (const p of Array.isArray(list) ? list : []) {
    const id = String(p?.id ?? '');
    if (!id) continue;
    const logo = typeof p.icon === 'string' ? sanitizeSvg(p.icon) : null;
    if (logo) out.logos[id] = logo;
    for (const i of Array.isArray(p.icons) ? p.icons : []) {
      const name = String(i?.name ?? '').toLowerCase();
      if (!/^[a-z0-9_-]{1,32}$/.test(name) || BUILTIN_ICONS[name] || ALIASES[name] || out.icons[name]) continue;
      const svg = typeof i.svg === 'string' ? sanitizeSvg(i.svg) : null;
      if (svg) out.icons[name] = { name, label: String(i.label || name.replace(/[_-]/g, ' ')).slice(0, 40), svg, from: String(p.name || id) };
    }
  }
  return out;
}

export function setExtIcons(v: ExtIcons) { ext = v; extVersion++; listeners.forEach((f) => f()); }
/** Reads the extensions' icons again (at start and when the extensions change). */
export function loadExtIcons() { return call('plugin_icons').then((l) => setExtIcons(extIconsFrom(l))).catch(() => {}); }
/** Re-renders when the extensions' icons change. */
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
const version = () => extVersion;
export function useExtIcons(): ExtIcons {
  useSyncExternalStore(subscribe, version);
  return ext;
}

// ---------------------------------------------------------------- names to what is drawn

export interface Resolved { name: string; label: string; builtin?: IconDef; svg?: string; color: string; known: boolean }

/** A colour as written (`red`, `#c00`, `#c00000`) as #rrggbb, or null when it is not one. */
export function colorHex(c?: string | null): string | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  const h = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s);
  if (h) return h[1].length === 3 ? `#${h[1].split('').map((x) => x + x).join('')}` : s;
  const n = COLORS[s] || COLORS[COLOR_ALIASES[s]];
  return n ? n.hex : null;
}

/** An icon name and colour as written in a script, made into what is drawn: an unknown or missing name is `play`,
 * a missing or unknown colour is the icon's own. */
export function resolveIcon(icon?: string | null, color?: string | null, icons: ExtIcons = ext): Resolved {
  const n = String(icon || '').toLowerCase();
  const b = BUILTIN_ICONS[n] ? n : ALIASES[n];
  if (b) return { name: b, label: BUILTIN_ICONS[b].label, builtin: BUILTIN_ICONS[b], color: colorHex(color) || COLORS[BUILTIN_ICONS[b].color].hex, known: true };
  const e = icons.icons[n];
  if (e) return { name: n, label: e.label, svg: e.svg, color: colorHex(color) || COLORS.blue.hex, known: true };
  return { name: 'play', label: BUILTIN_ICONS.play.label, builtin: BUILTIN_ICONS.play, color: colorHex(color) || COLORS.blue.hex, known: false };
}

/** Black or white, whichever reads better on a colour (WCAG relative luminance). */
export function inkOn(hex: string): '#000000' | '#ffffff' {
  const v = (i: number) => { const c = parseInt(hex.slice(i, i + 2), 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * v(1) + 0.7152 * v(3) + 0.0722 * v(5);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/** The shape alone (no disc), in the current text colour: for the activity bar and inline uses. */
export function IconShape({ r, size = 24 }: { r: Pick<Resolved, 'builtin' | 'svg'>; size?: number | string }) {
  if (r.svg) return <Box component="span" aria-hidden sx={{ display: 'inline-flex', width: size, height: size, '& > svg': { width: '100%', height: '100%' } }} dangerouslySetInnerHTML={{ __html: r.svg }} />;
  return (
    <Box component="svg" viewBox="0 0 24 24" aria-hidden sx={{ width: size, height: size, display: 'block' }}>
      {r.builtin!.paths.map((p, i) => p.stroke
        ? <path key={i} d={p.d} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
        : <path key={i} d={p.d} fill="currentColor" fillRule="evenodd" />)}
    </Box>
  );
}

/** An effect's icon: a disc in its colour with its shape, named for screen readers (`label` replaces the icon's
 * own name, for example "Skull: scare"). */
export function PropIcon({ icon, color, size = 24, label, tooltip = true, testId }: { icon?: string | null; color?: string | null; size?: number; label?: string; tooltip?: boolean; testId?: string }) {
  useExtIcons();
  const r = resolveIcon(icon, color);
  const name = label || r.label;
  const disc = (
    <Box component="span" role="img" aria-label={name} data-testid={testId} data-icon={r.name} data-color={r.color}
      sx={{ width: size, height: size, flexShrink: 0, borderRadius: '50%', bgcolor: r.color, color: inkOn(r.color), display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        boxShadow: (t) => `0 0 0 1px ${t.palette.divider}` }}>
      <IconShape r={r} size="64%" />
    </Box>
  );
  return tooltip ? <Tooltip title={name}>{disc}</Tooltip> : disc;
}

/** An extension's own icon (plugin.json "icon", sanitized) at the size of an activity bar icon, or `fallback`
 * when it has none. */
export function ExtensionLogo({ id, fallback, size = 24, label }: { id: string; fallback?: React.ReactNode; size?: number | string; label?: string }) {
  const icons = useExtIcons();
  const svg = icons.logos[id];
  if (!svg) return <>{fallback ?? null}</>;
  return (
    <Box component="span" role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-testid={`extension-icon-${id}`}
      sx={{ display: 'inline-flex', width: size, height: size, flexShrink: 0, '& > svg': { width: '100%', height: '100%' } }} dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

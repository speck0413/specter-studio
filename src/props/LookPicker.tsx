// The editor's "Icon and colour" button: picks an icon and a colour for the whole script or for one effect and
// writes them as comment lines (`# icon: skull`, `# color: purple`, look.ts). Nothing else in the text changes.
import { useMemo, useState } from 'react';
import { Box, Button, ButtonBase, MenuItem, Popover, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { lookOf, parseLook, setLook } from './look';
import { BUILTIN_ICONS, COLORS, colorHex, IconShape, inkOn, PropIcon, resolveIcon, useExtIcons } from './icons';

const SCRIPT = '\u0000script';

export default function LookPicker({ text, onChange, disabled }: { text: string; onChange: (text: string) => void; disabled?: boolean }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [target, setTarget] = useState(SCRIPT);
  const [hex, setHex] = useState('');
  const ext = useExtIcons();
  const parsed = useMemo(() => parseLook(text), [text]);
  const effect = target === SCRIPT ? null : target;
  // what is written for the target itself (empty: it takes the script's, or the built-in default)
  const own = effect === null ? parsed.script : parsed.effects.find((e) => e.name === effect)?.look || {};
  const shown = effect === null ? lookOf(text) : lookOf(text, effect);
  const current = lookOf(text);
  const icons = [...Object.entries(BUILTIN_ICONS).map(([name, d]) => ({ name, label: d.label, r: resolveIcon(name) })),
    ...Object.values(ext.icons).map((e) => ({ name: e.name, label: `${e.label} (from ${e.from})`, r: resolveIcon(e.name) }))];
  const set = (key: 'icon' | 'color', v: string | null) => onChange(setLook(text, effect, key, v));
  const hexOk = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex.trim());
  const shownColor = resolveIcon(shown.icon, shown.color).color;
  return (
    <>
      <Button variant="outlined" disabled={disabled} onClick={(e) => setAnchor(e.currentTarget)} data-testid="look-picker"
        startIcon={<PropIcon icon={current.icon} color={current.color} size={20} tooltip={false} label={`${resolveIcon(current.icon).label} icon`} />}>
        Icon and colour
      </Button>
      <Popover open={!!anchor} anchorEl={anchor} onClose={() => setAnchor(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        slotProps={{ paper: { sx: { p: 2, width: 380, maxWidth: '95vw' }, role: 'dialog', 'aria-label': 'Icon and colour' } as any }}>
        <Stack spacing={1.5}>
          <Typography variant="body2" color="text.secondary">Shown on the board cards and in your library, and over a card on the Dashboard when the effect starts. Saved as comment lines in the script, so it goes to the board with it.</Typography>
          <TextField select size="small" label="For" value={target} onChange={(e) => setTarget(e.target.value)}>
            <MenuItem value={SCRIPT}>The whole script (each effect's default)</MenuItem>
            {parsed.effects.map((e) => <MenuItem key={e.name} value={e.name}>Effect “{e.name}”</MenuItem>)}
          </TextField>
          <Stack direction="row" spacing={1} alignItems="center">
            <PropIcon icon={shown.icon} color={shown.color} size={36} label={`Now: ${resolveIcon(shown.icon).label}`} testId="look-preview" />
            <Typography variant="body2">{resolveIcon(shown.icon).label}{own.icon || own.color ? '' : effect === null ? ' (the built-in default)' : ' (from the whole script)'}</Typography>
          </Stack>
          <Typography variant="subtitle2" component="h4">Icon</Typography>
          <Box role="group" aria-label="Icon" sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 40px)', gap: 0.5 }}>
            {icons.map((i) => {
              const on = own.icon === i.name;
              return (
                <Tooltip key={i.name} title={i.label}>
                  <ButtonBase aria-label={i.label} aria-pressed={on} onClick={() => set('icon', on ? null : i.name)} data-testid={`look-icon-${i.name}`}
                    sx={{ width: 40, height: 40, borderRadius: 1, border: 2, borderColor: on ? 'primary.main' : 'transparent', color: 'text.primary', '&:hover': { bgcolor: 'action.hover' }, '&.Mui-focusVisible': { outline: 2, outlineColor: 'primary.main' } }}>
                    <Box component="span" sx={{ width: 30, height: 30, borderRadius: '50%', bgcolor: shownColor, color: inkOn(shownColor), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxShadow: (t) => `0 0 0 1px ${t.palette.divider}` }}>
                      <IconShape r={i.r} size="64%" />
                    </Box>
                  </ButtonBase>
                </Tooltip>
              );
            })}
          </Box>
          <Typography variant="subtitle2" component="h4">Colour</Typography>
          <Box role="group" aria-label="Colour" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
            {Object.entries(COLORS).map(([name, c]) => {
              const on = own.color === name;
              return (
                <Tooltip key={name} title={c.label}>
                  <ButtonBase aria-label={c.label} aria-pressed={on} onClick={() => set('color', on ? null : name)} data-testid={`look-color-${name}`}
                    sx={{ width: 28, height: 28, borderRadius: '50%', bgcolor: c.hex, boxShadow: (t) => `0 0 0 1px ${t.palette.divider}`, outline: on ? 3 : 0, outlineColor: 'primary.main', outlineOffset: 2, '&.Mui-focusVisible': { outline: 3, outlineColor: 'primary.main' } }} />
                </Tooltip>
              );
            })}
          </Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField size="small" label="Or a colour code" placeholder="#c00000" value={hex} onChange={(e) => setHex(e.target.value)} sx={{ flexGrow: 1 }}
              error={!!hex.trim() && !hexOk} helperText={hex.trim() && !hexOk ? 'Like #c00000 or #c00' : undefined} inputProps={{ 'data-testid': 'look-hex' }} />
            <Button disabled={!hexOk} onClick={() => { set('color', hex.trim().toLowerCase()); setHex(''); }}>Use it</Button>
          </Stack>
          {own.color && !COLORS[own.color] && colorHex(own.color) && <Typography variant="body2">Colour code: {own.color}</Typography>}
          <Stack direction="row" spacing={1} justifyContent="space-between">
            <Button disabled={!own.icon && !own.color} onClick={() => onChange(setLook(setLook(text, effect, 'icon', null), effect, 'color', null))}>
              {effect === null ? 'Use the defaults' : 'Same as the whole script'}
            </Button>
            <Button variant="contained" onClick={() => setAnchor(null)}>Done</Button>
          </Stack>
        </Stack>
      </Popover>
    </>
  );
}

// The side bar beside the work area (VS Code's explorer): a page can put its own list there (Your library) with
// SideBarContent; the shell owns the column, its width and whether it is shown.
import { createContext, ReactNode, useContext } from 'react';
import { createPortal } from 'react-dom';
import { Box, Stack, Typography } from '@mui/material';

/** the side bar's element; 'hidden' when the person hid it (Ctrl+B); null when the window is too narrow for one */
export const SideBarSlot = createContext<HTMLElement | 'hidden' | null>(null);

/** Puts its children into the side bar. Hidden side bar: nothing. No room for one (a narrow window): `inline`
 * content goes above the page instead, so a list is never out of reach. */
export function SideBarContent({ children, inline = false }: { children: ReactNode; inline?: boolean }) {
  const el = useContext(SideBarSlot);
  if (el === 'hidden') return null;
  if (el) return createPortal(children, el);
  return inline ? <Box sx={{ mb: 3, pt: 1, border: 1, borderColor: 'divider', borderRadius: 1, maxHeight: '40vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</Box> : null;
}

/** The side bar's title row: a small uppercase name and a few icon buttons. */
export function SideBarHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <Stack direction="row" alignItems="center" sx={{ minHeight: 35, pl: 3, pr: 1, flexShrink: 0 }}>
      <Typography component="h2" variant="overline" sx={{ flexGrow: 1, color: 'text.secondary', lineHeight: 1 }}>{title}</Typography>
      {children}
    </Stack>
  );
}

/** A side bar section's scrolling body. */
export function SideBarBody({ children, label }: { children: ReactNode; label: string }) {
  return <Box component="nav" aria-label={label} sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pb: 2 }}>{children}</Box>;
}

// Where the SD card tool is: link to it from anywhere (the board page's sound tile, the library) without
// importing the page itself.
//
//   import { openSdCardTool } from '../sdcard/link';
//   const nav = useNav();
//   <Button onClick={() => openSdCardTool(nav.go)}>Put sounds on the SD card…</Button>
import { useCallback } from 'react';
import { useNav, type Loc } from '../nav';

/** The SD card tool's view id (shell/views.tsx). */
export const SDCARD_VIEW = 'sdcard';
/** The SD card tool as a place in the app (for `nav.go`). */
export const sdCardLoc: Loc = { view: SDCARD_VIEW };

/** Opens the SD card tool (a new history entry, so Back returns). */
export function openSdCardTool(go: (loc: Loc) => void) {
  go(sdCardLoc);
}

/** A function that opens the SD card tool, for components inside the app. */
export function useOpenSdCardTool() {
  const { go } = useNav();
  return useCallback(() => openSdCardTool(go), [go]);
}

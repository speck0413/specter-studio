// A link to the SD card tool at the bottom of Your library's side bar (shell/views.tsx puts it beside the
// library page).
import { Box, Button } from '@mui/material';
import SdCardIcon from '@mui/icons-material/SdCard';
import { SideBarContent } from '../shell/SideBar';
import { useOpenSdCardTool } from './link';

export default function LibrarySdCardLink() {
  const open = useOpenSdCardTool();
  return (
    <SideBarContent>
      <Box sx={{ px: 2, py: 1.5, borderTop: 1, borderColor: 'divider', flexShrink: 0 }}>
        <Button fullWidth startIcon={<SdCardIcon />} onClick={open} data-testid="library-sdcard">SD card for sounds…</Button>
      </Box>
    </SideBarContent>
  );
}

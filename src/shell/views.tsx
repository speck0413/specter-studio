// Every place in the app, in one list: the activity bar, the command palette's "Go to", back and forward, and
// the status bar all read it. A new destination is one entry here (and its page component).
import { ReactNode } from 'react';
import DeveloperBoard from '@mui/icons-material/DeveloperBoard';
import LibraryBooks from '@mui/icons-material/LibraryBooks';
import Terminal from '@mui/icons-material/Terminal';
import History from '@mui/icons-material/History';
import SpaceDashboard from '@mui/icons-material/SpaceDashboard';
import Extension from '@mui/icons-material/Extension';
import SettingsIcon from '@mui/icons-material/Settings';
import HelpOutline from '@mui/icons-material/HelpOutline';
import SdCardIcon from '@mui/icons-material/SdCard';
import type { Loc } from '../nav';
import Boards from '../pages/Boards';
import BoardPage from '../pages/BoardPage';
import Workspace from '../pages/Workspace';
import Settings from '../pages/Settings';
import Plugins from '../pages/Plugins';
import SerialMonitor from '../pages/SerialMonitor';
import Help from '../pages/Help';
import Activity from '../pages/Activity';
import Dashboard from '../pages/Dashboard';
import SdCard from '../pages/SdCard';
import LibrarySdCardLink from '../sdcard/LibraryLink';
import { SDCARD_VIEW } from '../sdcard/link';
import BoardsSideBar from './BoardsSideBar';
import { ExtensionLogo } from '../props/icons';

export interface ViewCtx { loc: Loc; dark: boolean; plugins: any[] }

export interface View {
  id: string;
  /** the name everywhere (activity bar tab, palette, breadcrumbs) */
  label: string;
  /** the word under the activity bar icon */
  short: string;
  icon: ReactNode;
  /** what the place is for, in the activity bar's tooltip and the palette */
  hint: string;
  /** keyboard shortcut to go there ("Mod" = Ctrl, or ⌘ on a Mac) */
  keys?: string;
  /** only in Advanced mode */
  advanced?: boolean;
  /** at the bottom of the activity bar (Settings, Help) */
  bottom?: boolean;
  /** a side bar beside the work area: its content, or true when the page puts its own there (SideBarContent) */
  sideBar?: true | ((ctx: ViewCtx) => ReactNode);
  /** the page takes the whole work area, without padding (a plugin's frame) */
  fill?: boolean;
  render: (ctx: ViewCtx) => ReactNode;
}

export function views(advanced: boolean, plugins: any[]): View[] {
  const all: View[] = [
    {
      id: 'boards', label: 'Boards', short: 'Boards', icon: <DeveloperBoard />, keys: 'Mod+1',
      hint: 'Your boards: open one to see its inputs and outputs, change its effect, settings and backups.',
      sideBar: () => <BoardsSideBar />,
      render: ({ loc, dark }) => (loc.board ? <BoardPage key={loc.board} boardKey={loc.board} dark={dark} initialTab={loc.tab} /> : <Boards addSeq={loc.add ? loc.seq || 1 : 0} />),
    },
    {
      id: 'dashboard', label: 'Dashboard', short: 'Dashboard', icon: <SpaceDashboard />, keys: 'Mod+2',
      hint: 'Every board at a glance: runs tonight and lifetime, a live feed of what happens, and past nights.',
      render: () => <Dashboard />,
    },
    {
      id: 'library', label: 'Your library', short: 'Library', icon: <LibraryBooks />, keys: 'Mod+3',
      hint: 'Your effects (and your own firmware): change them, try them on a practice board, send them to boards.',
      sideBar: true,
      render: ({ loc, dark }) => <><Workspace dark={dark} loc={loc} /><LibrarySdCardLink /></>,
    },
    {
      id: SDCARD_VIEW, label: 'SD card', short: 'SD card', icon: <SdCardIcon />,
      hint: 'Put sounds on the SD card for the sound player, numbered and in the right order, or check a card.',
      render: () => <SdCard />,
    },
    { id: 'serial', label: 'Serial monitor', short: 'Serial', icon: <Terminal />, advanced: true, hint: 'What a board plugged in by USB prints, and a plotter.', render: () => <SerialMonitor /> },
    { id: 'activity', label: 'Activity', short: 'Activity', icon: <History />, advanced: true, hint: 'Everything that happened, across all boards, newest first.', render: () => <Activity /> },
    ...plugins.filter((p) => p.entry).map((p): View => ({
      id: `plugin:${p.id}`, label: p.name || p.id, short: shortName(p.name || p.id), icon: <ExtensionLogo id={p.id} fallback={<Extension />} />, fill: true,
      hint: `The extension “${p.name || p.id}”.`, render: ({ plugins: list }) => <Plugins plugin={list.find((x) => x.id === p.id)} />,
    })),
    { id: 'settings', label: 'Settings', short: 'Settings', icon: <SettingsIcon />, bottom: true, keys: 'Mod+,', hint: 'Theme and text size, folders, firmware updates, sharing.', render: () => <Settings /> },
    { id: 'help', label: 'Help', short: 'Help', icon: <HelpOutline />, bottom: true, hint: 'Where to start, and the wiring guides.', render: () => <Help /> },
  ];
  return all.filter((v) => advanced || !v.advanced);
}

// an extension's name under its icon: the first word, at most 9 letters
const shortName = (n: string) => { const w = n.split(/\s+/)[0]; return w.length > 9 ? `${w.slice(0, 8)}…` : w; };

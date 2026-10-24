// The consent screen: what a plugin asks for (its MQTT topics, actions, network access, control of boards), shown
// once for exactly that; nothing of the plugin runs before the person allows it.
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, List, ListItem, ListItemText, Typography } from '@mui/material';
import { useStore } from '../store';
import { describePerms, fingerprint, perms } from './pluginPerms';

export function needsConsent(plugin: any) {
  const p = perms(plugin);
  return !!(p.subscribe.length || p.publish.length || p.actions.length || p.http || p.control || p.firmware.length || plugin?.adapter);
}

export function useConsent(plugin: any): [boolean, (v: boolean) => void] {
  const { prefs, setPrefs } = useStore();
  // remembered for exactly what it asked for, from that folder: a plugin.json that asks for more asks again
  const fp = fingerprint(plugin);
  const ok = !needsConsent(plugin) || prefs.pluginConsent?.[plugin.id] === fp;
  return [ok, (v) => setPrefs({ pluginConsent: { ...(prefs.pluginConsent || {}), [plugin.id]: v ? fp : false } })];
}

export default function PluginConsent({ plugin, onAnswer }: { plugin: any; onAnswer: (allowed: boolean) => void }) {
  const lines = describePerms(perms(plugin));
  return (
    <Dialog open fullWidth maxWidth="sm" aria-labelledby={`consent-${plugin.id}`}>
      <DialogTitle id={`consent-${plugin.id}`}>Allow “{plugin.name || plugin.id}”?</DialogTitle>
      <DialogContent>
        {plugin.description && <Typography gutterBottom>{plugin.description}</Typography>}
        <Typography>This extension asks to:</Typography>
        <List dense>
          {plugin.adapter && <ListItem><ListItemText primary="Run in the background and show its devices on the Boards page" /></ListItem>}
          {lines.map((l) => <ListItem key={l}><ListItemText primary={l} /></ListItem>)}
        </List>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onAnswer(false)}>Not now</Button>
        <Button variant="contained" onClick={() => onAnswer(true)}>Allow</Button>
      </DialogActions>
    </Dialog>
  );
}

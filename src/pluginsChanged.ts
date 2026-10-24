// Extensions were added, updated or removed (components/GitExtensions.tsx): every list of them reads again, so a
// plugin.json that now asks for more meets the consent screen before its page or adapter loads.
const EVENT = 'studio-plugins-changed';
export function pluginsChanged() { window.dispatchEvent(new Event(EVENT)); }
export function onPluginsChanged(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}

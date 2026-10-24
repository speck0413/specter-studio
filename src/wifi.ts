// Wi-Fi words shared by the settings picker and the board page: signal strength, the scan's status line and
// where the board can be found on the network (PROTOCOL.md "Wi-Fi scan" and `state.net`).

export type WifiNetwork = { ssid: string; rssi: number; secured: boolean };
/** A `wifi_scan` answer (result), or what Studio keeps when asking failed. */
export type WifiScan = { scanning?: boolean; networks: WifiNetwork[]; age_ms?: number; retry_ms?: number; error?: string };

/** Signal strength in words and bars, as the board's own page says it. */
export const signalWords = (rssi: number) => (rssi >= -60 ? 'strong' : rssi >= -72 ? 'good' : rssi >= -82 ? 'weak' : 'very weak');
export const signalBars = (rssi: number) => (rssi >= -60 ? '▂▄▆█' : rssi >= -72 ? '▂▄▆' : rssi >= -82 ? '▂▄' : '▂');

/** The line under the network field: what the board is doing and what to do next. */
export function scanStatus(s: WifiScan | null): string {
  if (!s || s.scanning) return 'Looking for networks…';
  if (s.error) return `The board could not look for networks: ${s.error}. Type the name, or Rescan.`;
  if (s.retry_ms) return `Looked ${Math.round((s.age_ms || 0) / 1000)} s ago; Rescan works again in ${Math.ceil(s.retry_ms / 1000)} s.`;
  if (s.networks.length) return `Networks this board can see, strongest first${(s.age_ms || 0) > 5000 ? ` (${Math.round((s.age_ms || 0) / 1000)} s ago)` : ''}. Pick one, or type the name.`;
  return 'The board sees no networks. Type the name, or Rescan.';
}

/** What to do after picking a network. `keepsPassword`: the picked network is the one the board already has and
 * a password is stored for it (an empty field keeps it then). A new network saved with the password empty is
 * joined as an open one: the board drops the old network's password (PROTOCOL.md set_params). */
export function pickHint(n: WifiNetwork, keepsPassword: boolean): string {
  if (n.secured) return `Now type the password of “${n.ssid}” in Wi-Fi password, then Save settings.`;
  return keepsPassword
    ? `“${n.ssid}” is open (no password), and this board still keeps a password for it from before (an empty field does not remove it), which may stop it joining.`
    : `“${n.ssid}” is open (no password): leave Wi-Fi password empty, then Save settings.`;
}

/** Before saving settings: a new network the board saw with a password, and no password typed, would be saved as
 * an open one and never joined. Its name then (nothing may be saved), else null. A network the board did not
 * see, or saw as open, saves as it is (as on the board's own page). */
export function needsPassword(edits: Record<string, any>, saved: Record<string, any>, networks: WifiNetwork[]): string | null {
  const ssid = edits.wifi_ssid;
  if (typeof ssid !== 'string' || !ssid || ssid === saved.wifi_ssid) return null;
  if (typeof edits.wifi_pass === 'string' && edits.wifi_pass !== '') return null;
  return networks.some((n) => n.ssid === ssid && n.secured) ? ssid : null;
}

/** Where the board answers on the network, from `state.net`: its name address first (net.host), else its IP. */
export function boardAddress(net: any): { url: string; also?: string; on?: string } | null {
  if (!net) return null;
  if (net.mode === 'sta') {
    if (net.host) return { url: `http://${net.host}/`, also: net.ip ? `http://${net.ip}/` : undefined, on: net.ssid || undefined };
    if (net.ip) return { url: `http://${net.ip}/`, on: net.ssid || undefined };
    return null;
  }
  if (net.mode === 'ap') return { url: `http://${net.ip || '192.168.4.1'}/`, on: net.ssid || undefined };
  return null;
}

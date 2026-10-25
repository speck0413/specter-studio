# Specter Studio: design

## Architecture

```
React + MUI (src/)  ──call(cmd, args) / events──►  Tauri shell (src-tauri/)  ──►  studio-core (core/)
        │                                          or the bridge (browser)            │
        └─ plugin frames (postMessage, narrow API)                                    ├─ one session per board: WebSocket /api/v1/ws or USB serial JSON lines
                                                                                      ├─ discovery: UDP 47800, mDNS _proptroller._tcp, typed address, 192.168.4.1
                                                                                      ├─ practice boards: the firmware's own simulator (sidecar)
                                                                                      ├─ updates (POST /api/v1/update), backups, release manifest
                                                                                      ├─ library (effects/, firmware/, .specter/ index and history)
                                                                                      ├─ builds (hidden PlatformIO project per sketch), USB flash plans
                                                                                      └─ serial monitor, BOOTSEL drives, keychain (page passwords, opt-in)
```

- **One door.** The UI never talks to a board itself (the boards' CORS admits only the app). Every action is
  `dispatch(command, json)`; boards' pushes come back as events. The Tauri shell and the browser bridge are each
  about 80 lines around `studio-core`, so the whole app runs in Playwright against the real device layer.
  The bridge listens on 127.0.0.1 only, refuses pages from other origins and wants its token in the WebSocket
  URL (`SPECTER_BRIDGE_TOKEN`, else random and written to `<temp>/specter-bridge-<port>.token`, which the dev
  server's `/__bridge` proxy adds), so another program on the computer cannot drive it. Whatever the UI asks,
  file reads and writes stay in the library folder the core remembers (`workspace_set`, or a library listing),
  `secret_get` answers only page passwords (the sharing and MQTT upstream passwords are used in the core), and
  commands the UI never sends (`flash`, `probe`, `mqtt_rpc`, ...) are only in `Studio::dispatch_dev` (tests).
- **Sessions.** Requests travel over the board's WebSocket (or serial line) and are matched by `id`, so grants
  that live as long as a session (the remote trigger enable) work. Sessions answer pings and reconnect by
  themselves (after an update's restart, a Wi-Fi drop).
- **No second simulator or checker.** Practice boards, the effect checker and the tests use the firmware's own
  `sim` build (the C++ controller code on this computer) from the `firmware` submodule; nothing is copied.
- **Recognising what runs where.** A script Studio sends carries one comment line,
  `# Specter Studio: <name>, saved <time>`; the library's hidden index maps content hashes to names and save
  times, and keeps a copy of every saved version. So a board's text alone says which effect and which version
  it runs, on any computer with the library folder. Own firmware is built with `PROPTROLLER_FW_BUILD` set to
  `<name> v<N>` (N rises with every build) and recognised from the board's `fw_build`.
- **Plain words.** Beginner mode says Boards, Effects, Send to board, Update, Back up, Your library; Advanced
  mode adds addresses, versions, the protocol console, the build log and the C++ preview.

## Screens and layout

A desktop editor's layout, with VS Code as the reference (`src/App.tsx`, `src/shell/`), on MUI only:

- **Title bar**: Specter Studio, Back and Forward, a search box in the middle that opens the command palette
  (it says "Search boards, effects and commands" and shows Ctrl+Shift+P, so the palette is found without knowing
  the shortcut), Stop all boards (always in view), Advanced, and the light/dark switch.
- **Activity bar** (left, 56 px): one icon per place with its short name under it and a tooltip naming the place,
  what it is for and its shortcut: Boards (Ctrl+1), Dashboard (Ctrl+2), Your library (Ctrl+3), Serial monitor and Activity (Advanced),
  extensions, and at the bottom Settings (Ctrl+,) and Help. Clicking the place you are in goes to its start (all
  boards, the library without an effect open). It is a vertical tab list, so screen readers hear the places.
- **Side bar** (Boards, Your library): the list of the place's things, 170 to 520 px wide (drag the divider, or
  focus it and use the arrow keys; double-click resets it), hidden and shown with Ctrl+B. Boards: every board with
  a dot for connected, and a word when it needs you ("not answering", "stopped", "update", "newer effect");
  clicking one opens it, right-click (or the ⋯ button, or Shift+F10) has Open, Its effect script, Its settings,
  Send an effect…, Update firmware, Back up, Stop, Restart and Remove. Your library: New effect, Start from an
  example, the effects (right-click: Open, Rename…, Duplicate…, Delete…), your own firmware (Advanced), the sounds. A window narrower than 700 px has no side bar;
  the library's list then sits above the editor.
- **Work area**: the open thing with a breadcrumb title ("All boards › Porch", "Your library › porch light"),
  its actions in one row beside the title, and its sections as tabs (a board's Effect script, Plot, Settings,
  Backups, Activity). A board on a wide window (from 1200 px) keeps its Live inputs and outputs in a resizable
  pane on the right; narrower windows have a Live tab. Every view says what to do next when it is empty.
- **Status bar** (22 px): connected boards ("2 of 3 boards online", or that Studio's device service is not
  answering), the fleet server on or off (opens Settings), Ctrl+Shift+P, the text size (click: back to 100 %) and
  the theme (click: a menu of themes).
- **Places in one list** (`src/shell/views.tsx`): the activity bar, the palette's "Go to", Back/Forward and the
  status bar read it. A new destination is one entry there plus its page. The Dashboard sits between Boards and
  Your library.

**Density** (`src/theme.ts`): a 13 px UI font, 26 px buttons, inputs, list rows and tabs, 4 px spacing steps,
small headers (15 px page titles, 13 px sections), 4 px corners, flat outlined surfaces and no ripples. Keyboard
focus shows as a 2 px ring in every theme; targets stay at least 24 px (WCAG 2.2 AA). The record effect's tap
buttons stay big on purpose. Settings are one column of titled sections divided by lines, like VS Code's.

**Themes**: Light, Dark, Gruvbox, Gruvbox light, Obsidian (near-black greys, purple accent) and Halloween
(pumpkin orange and purple on near-black). One token set per theme in `theme.ts` (surfaces for the editor, side
bar, activity bar, title and status bars; text; accent; ok / warning / error / info; output on and off; focus);
components take colours only from the theme, and the code editor (Monaco) and the blocks (Blockly) get the same
surfaces; plot lines take a series palette for light or dark themes (3:1 on the plot). The default follows the computer's light or dark setting. Settings has the picker; the status bar's theme
opens the same list; the top bar's switch goes to the theme's partner (Light and Dark, Gruvbox and Gruvbox light;
Obsidian and Halloween go to Light). `src/theme.test.ts` checks every theme: text, muted text, the accent and the
status colours at 4.5:1 on every surface, text on every filled colour, the bars, ok / warning / error at least 30°
apart in hue, and an output that is on against one that is off; the end-to-end test runs axe on four pages in
every theme.

**Text size** (zoom): Ctrl+= or Ctrl++ and Ctrl+- (⌘ on a Mac), Ctrl+mouse wheel or a trackpad pinch, Ctrl+0 for
100 %; 70 to 200 % in 10 % steps. It scales the theme's type, spacing and control sizes together (and the code
editor's font), like VS Code's zoom, so layouts keep their shape. Studio handles these keys and the wheel itself
and stops the browser's or webview's own zoom and the page's scroll (Tauri's `zoomHotkeysEnabled` stays off).
Settings has the same choice; the status bar shows it.

**Remembered** (with the other preferences, `specter-prefs`): the theme, the text size, the side bar's width and
whether it is hidden, and the Live pane's width.

**Keyboard** (Alt+arrows and ⌘[ ⌘] stay the editor's own in text fields and the code editor): Ctrl+Shift+P or F1 (F1 stays Monaco's own inside the code editor) or Ctrl+P: the command palette;
Ctrl+1 / Ctrl+2 / Ctrl+3 / Ctrl+,: places; Ctrl+B: side bar; Alt+Left / Alt+Right (⌘[ / ⌘] on a Mac, and the mouse's back
and forward buttons): back and forward; Ctrl+= / Ctrl+- / Ctrl+0: text size.

**Command palette** (`src/shell/CommandPalette.tsx`): every place, every board ("Open board: Porch"), every effect,
the open board's sections and Stop / Restart / Back up, Stop all boards, Add a practice board, Find or add boards,
New effect…, Back up all boards, Advanced on/off, side bar, back/forward, text size and every theme, each with its
shortcut. Every typed word must appear; the name as typed comes first.

**Back and forward** (`src/nav.tsx`): where you are is one value: the place, the open board and its section, or
the open effect / firmware. Every jump goes through it (side bar, cards, palette, "Open in Your library", the
library's "Boards running" chips), so Back always returns: a board comes back on the section it was on. A removed
board is skipped. The history is Studio's own (50 places), not the browser's.

### Flows before and after

Before (Material 3 pass, a1be1cf):

```
find a board   rail Boards ─► grid ─► card Open ─► board page (grid gone) ─► another board: "All boards" ─► grid ─► Open
edit + send    board page ─► Effect script tab ─► edit ─► Save and send ─► Live pane (wide) / Live tab (narrow)
library        rail Your library ─► list column in the page ─► effect ─► Try it on a practice board (tiles under the editor)
               ─► Send to board  ·  "Boards running" chip ─► board page (rail jumps to Boards; no way back to the effect)
board ↔ library "Open in Your library" ─► library (the board is gone; back = rail Boards ─► grid ─► Open ─► Effect script)
serial monitor Advanced on ─► rail Serial monitor
firmware       card "Update firmware" or board page button; source in Settings; "Update firmware on all N" on Boards
discover       rail labels only; actions only on cards and page headers; no shortcuts; no search
```

After:

```
find a board   Boards (Ctrl+1) ─► side bar: click a board ─► board page; the list stays, the next board is one click
               or Ctrl+Shift+P "porch" ─► Open board: Porch
edit + send    board page ─► Effect script tab ─► edit ─► Save and send ─► Live pane beside (resizable) ─► Alt+Left: back
library        Your library (Ctrl+3) ─► side bar: effect ─► "Your library › name" ─► Try it on a practice board ─► Send
               "Boards running" chip ─► that board's Effect script ─► Alt+Left ─► the effect again
board ↔ library "Open in Your library" and the chips, both ways; Back and Forward between them
serial monitor Advanced on ─► activity bar Serial (or the palette: Go to Serial monitor)
firmware       side bar shows "update" ─► right-click ─► Update firmware; the board page button; the overview's "Update all"
discover       activity bar tooltips with shortcuts, the title bar's search box, the palette listing everything with its
               shortcut, empty-state hints in each view, clickable status bar, right-click menus on boards
first run      welcome steps ─► Done ─► the Boards view with the new boards in the side bar
```

**One effect editor** (`src/effects/ScriptEditor.tsx`): the script (Monaco, the effect language), the blocks,
the board's own checker and go-to-line, used by the library's effect page and by a board's page. On a board's
page (`src/components/BoardScript.tsx`) the editor shows what the board runs, without Studio's header line; an
edit stays on this computer (kept while Studio runs, `boardScriptDrafts`, and named when closing) until it goes
out: **Save and send** (into the library under the effect's name, or a new name for a script that is not in the
library, then sent from the library), **Send to this board only** (`send_script` with `text`: under the effect's
name with the send time in the header, so the badge reads "changed on the board"; without a name no header, "not
in your library") or **Save to library only** (the board keeps its version; the badge reads "newer version in
your library"). Saving over a newer or different library copy asks first. A send from the board page does not
copy the board's old script into the library as "kept from ..." (the person edited or chose to replace it).
**Open in Your library** opens the effect there; **Compare with Your library** shows both in Monaco's diff view
with "Send Your library's version" and "Save the board's version"; the library's "Boards running" chips open
that board's script.

## Plugins

A folder with `plugin.json` (`id`, `name`, `entry`) and web files, found in the app config dir's `plugins/`,
the repo's `plugins/` (development bridge, only with `SPECTER_STUDIO_EXAMPLE_PLUGINS=1`) and `SPECTER_STUDIO_PLUGINS`. Studio shows it in a frame with
`sandbox="allow-scripts allow-forms"` (no same origin). The sandbox takes away the origin, not the network, so
every plugin and wiring-guide response from both servers (the `plugin://` scheme and the bridge) carries its own
Content Security Policy (`core/src/plugins.rs` `PLUGIN_CSP`): the plugin's own files and inline code only;
`connect-src 'none'` (no fetch, WebSocket, EventSource, beacon), no images or media from elsewhere, no frames,
workers, forms or `<base>`. The window's own CSP lets frames load only from the plugin scheme, so a plugin cannot
navigate its frame to another site either. CSP does not cover WebRTC: every plugin HTML page gets a first
script (`PLUGIN_PRELUDE`) that removes `RTCPeerConnection` and friends before the plugin's code runs; Windows
(WebView2) also starts with `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`; Linux (WebKitGTK) has
WebRTC off by default (`enable-webrtc`). Verified: the CSP, the prelude and blocked fetch/WebSocket/beacon in
Chromium (`tests/e2e/csp.spec.ts`), and Tauri's IPC refusing a plugin frame on Linux
(`scripts/test-plugin-isolation.sh`, which also tries fetch, WebSocket and WebRTC: run on the release build
under `xvfb-run` on 2026-10-22, all blocked, WebRTC gone, the probe's inline script ran under the CSP). Not verified: Windows and
macOS (WKWebView has WebRTC and no switch for it; the prelude is the only guard there, and a plugin that makes a
nested about:blank frame could get the constructors back from it). API (`plugins/board-list/studio-plugin.js`):
`boards()`, `rpc(key, request)` (an allowlist: reading, running, testing, settings other than passwords, Wi-Fi,
name and page lock, profiles), `subscribe(fn)` (board
events, `online`, `boards_changed`, and `board_info` with the new info when a board's firmware type, version, name
or board package changes, after a restart or an update), and two requests Studio carries out itself after asking the person:
`updateFirmware(key)` (the board's own firmware type, never another) and `sendScript(key, text)`. A plugin can
also add firmware types with their own release lists (`"firmware"` in plugin.json, see Firmware types). Its own icon (`"icon"`) and more effect icons (`"icons"`): see Effect icons and runs on the cards.

MQTT for plugins and device adapters, on Studio's server (the embedded broker listens on 1883 by default, since
some boards' firmware cannot be told another port; a taken port is reported in plain words): plugin.json
`"mqtt": {"subscribe": [filters], "publish": [filters], "actions": [filters]}` (or a list for both).
`studio.mqttSubscribe(filter, fn)` delivers `{type: "mqtt", topic, payload, retained}`: first the server's stored
(retained) copies, flagged `retained: true` (not news: no proof a device is alive), then live messages
(`retained: false`). `studio.mqttPublish(topic, payload)` is QoS 0 and never retained; topics under `actions` are
agreed once on the consent screen and every one is written to the activity log. Board requests: every plugin
may read (info, state, shows, settings, script); making a board act (run, stop, pause, cue, test outputs, sound,
pixels, actions, settings) needs `"control": true`, is agreed on the consent screen and logged; settings only by a
key the board lists (aliases refused) and never identity, access, network, safety limits or roles; profiles,
passwords, scripts, firmware, restarts and backups never. Outputs a plugin turned on are let go when its page
closes. Scripts and firmware updates a plugin asks for are shown in Studio's own dialog (the plugin, the board, the
whole script); a "no" holds the plugin off for 30 s. Subscribed plugins get board events only (never serial,
build, MQTT or fleet events). Every plugin that asks for topics, network access, control or to run as an adapter
shows a consent screen listing them; nothing of it runs before "Allow", and the answer is remembered for exactly
that plugin.json in that folder (asking for more asks again). Checked in `src/components/pluginPerms.ts` (unit tests) and end to end with a test plugin
(`tests/plugins-e2e/mqtt-probe`). Specialised clients (a project's own words and controls) live in their own
repositories; nothing project-specific is in this one.

## Device adapters

An extension can bring a device that does not speak the Proptroller protocol. Its plugin.json names a hidden
page (`"adapter": "adapter.html"`) that Studio loads in a sandboxed frame for as long as it runs, and the topics
it may use (`"mqtt"`, see Plugins). The page speaks for its devices in the Proptroller protocol's words, so the
grid, badges where they apply, live tiles, settings (with readback), the device's own actions, Stop, Restart and
Activity all work unchanged (`src/components/Adapters.tsx`; client: `plugins/demo-lamp/studio-adapter.js`):

| adapter -> Studio | |
|---|---|
| `adapter.devices([Device])` / `adapter.device(Device)` | the device list / one device (also "heard from it"). `Device = {id, name, online, info, state, stale_ms}`; `info` as `GET /api/v1/info` (`kind` for the card, `fw_version`, `capabilities`, `channels`, `actions`, `terminals`), `state` as `/api/v1/state` |
| `adapter.event(id, {event: 'state' or 'log', data})` | a protocol event (logs land in Activity; presses and effects are read from states) |
| `adapter.onRequest(async (id, req) => envelope)` | Studio's requests: `info`, `state`, `get_params`, `set_params` (answer once the device confirms), `set_output`, `action`, `reboot`, `pause`, `stop_all`; anything else `{ok:false, error:{code:'unsupported'}}`. A request expires after 5 s; nothing is queued |
| `adapter.mqtt.subscribe(filter, fn)`, `adapter.mqtt.publish(topic, payload)` | on Studio's MQTT server, within plugin.json's topics |
| `adapter.http(url, {verb, body})` | local-network addresses only (`"http": true`) |

A device counts as offline after `stale_ms` (default 1.5 s) without news; its controls are then disabled.
Example: `plugins/demo-lamp/` (a made-up lamp protocol over MQTT), tested end to end in `tests/e2e`.

## Fleet server (MQTT) and sharing

- `core/src/mqtt.rs`: Studio runs a broker (rumqttd) when "Boards report to this computer" is on.
  - It watches every board's `online` / `state` / `status/*` and can send requests (`<p>/rpc` -> `<p>/rpc/reply`).
  - Every message is also offered to the automation rules (see Automation).
  - A bridge ("Connect to another MQTT server", Settings, Automation) links Studio to another broker:
    - out, in or both ways, with topic filters (local names, `#` by default), a prefix on the far side, QoS 1,
      TLS optional, the password in the keychain;
    - retained-ness follows the protocol's topic list, so the far side always holds each board's latest state and
      online / offline (last wills included);
    - while upstream is away, only the latest retained message per topic is kept (bounded).
  - Loops are prevented by `EchoGuard`, which is bounded and kept across restarts:
    - a message the bridge brought in is recognised when Studio's own subscription delivers it, and is not sent up;
    - a live copy of what Studio sent up is recognised when it comes back (`ECHO_TTL`);
    - a retained copy equal to the last value sent on that topic is never taken back in, since those come back on
      every reconnect.
    - retained copies brought in from the far side reach Studio's server but do not fire automation rules (they
      come again on every reconnect).
  - Requests to boards from upstream (`rpc`, `config/set/*`, `control/*`, `cue`, `script/set|check`,
    `status/get/*`, `broadcast/getName`) are refused and counted unless allowed.
  - Reconnects back off from `BRIDGE_RETRY_FIRST` to `BRIDGE_RETRY_MAX` on a deadline inside the bridge task.
    Messages keep being taken while it waits, so nothing is held up.
  - The status has `state` (connecting / connected / retrying), `retry_in_s` and `last_error` in plain words
    ("Nothing answered at … port …", "… did not accept the user name or password", TLS problems), plus counters.
- `core/src/viewer.rs`: "Share with others", a read-only page + Server-Sent Events on the LAN, optional view
  password.
- Built to grow into the full fleet commander: the broker, each bridge and the viewer are separate pieces in
  the core with their own status; next are several bridges with per-route counters, a broker monitor page
  (clients, latest message per topic, received requests, connection log), using an external broker instead of
  the embedded one (the monitor is a subscriber either way), a separate observer password, and a headless mode
  (the bridge binary already serves the device layer to a browser; it would also serve the built UI with a
  login, on an always-on box).

## Automation (message rules)

"When a message arrives on … send a web request to …", for clerical work: a row in a Google Sheet per check-in,
with counts and times (README "Automation" has the user's guide, the Google Apps Script and Google Form
recipes, and a ready-to-import rule). `core/src/automation/`:

- `pattern.rs`: patterns compile to an MQTT filter plus a matcher that captures names.
  - `*` (or `+`) is one level, `{name}` is one level captured, `#` / `**` last is the rest, and a leading `/` is
    ignored on patterns and topics.
  - Refused in plain words: an empty `{}`, duplicate or built-in names, `#` not last, empty levels, a partial
    wildcard (`room*`).
- `template.rs`: only `{` + a letter or `_` starts a value, so JSON bodies keep their braces; `{{` / `}}` are
  literal.
  - Values: captured names, `topic`, `payload`, `payload.a.b` (JSON; empty plus a note when missing),
    `timestamp` (local ISO 8601 with offset, chrono), `date`, `time`, `unix`, `count.name[key]`, and the timer
    values `elapsed`, `elapsed_text`, `started_at`, `sequence`.
  - Escaping follows where the value goes: CSV quoting with formula-looking values prefixed by `'`, JSON string
    escaping, URL encoding in the address and form bodies, no line breaks in headers.
  - Unknown values, timer values without a timer, a value in the server name, and a JSON body that does not parse
    with stand-ins are errors at save time.
- `state.rs`: counters (never below 0, optional key per captured name) and timers.
  - A start pushes a time and the day's group number for its key. A complete takes the latest start (and drops
    older open ones) or the oldest open one (first in, first out).
  - Bounded by `MAX_OPEN_STARTS_PER_KEY` and `MAX_KEYS`. Written to `automation-state.json` in the config
    folder, debounced by `STATE_SAVE_DELAY`, mode 0600.
- `delivery.rs` (`Delivery`): one queue per destination (scheme, host and path), worked by its own task one
  request at a time.
  - A start row always lands before its finish row in the same sheet, and a dead address never holds up another.
  - `QUEUE_LIMIT` covers every queue together; the oldest waiting request is dropped and counted. The rate limit
    stays per rule (a token bucket, `RATE_LIMIT_BURST`, `RATE_LIMIT_PER_MINUTE`): skipped and counted, with one log
    line per run of skips.
  - Waiting requests are written to `automation-queue.json` (atomic, 0600, with the state writer). They hold no
    secret values: a secret header or address part carries only its keychain name, filled in when sending.
  - `HTTP_TIMEOUT`. Automatic retries happen only when nothing reached the server (`NotSent`: connect, DNS, TLS
    handshake), backing off from `RETRY_FIRST_DELAY`, and on 429 / 503, honouring `Retry-After` (seconds or a date)
    up to `RETRY_AFTER_MAX`; `MAX_ATTEMPTS` tries.
  - A timeout, a broken connection or another 5xx (`MaybeSent`) is logged as "may have been sent: check the sheet",
    and 4xx as refused, each with "Send again" (`automation_resend`; the last `RESEND_KEEP` are kept).
  - `{event_id}` (16 hex characters per message and rule) stays the same across retries and Send again, so the
    Apps Script in the README skips a row it already has.
  - The last `LOG_LEN` results per rule are kept. Redirects are followed (Apps Script answers `/exec` with a 302).
- `mod.rs` (`Engine`): the MQTT server's plain thread calls `offer`, which never waits and never needs the async
  runtime. For each matching rule it:
  - reads an `Arc` snapshot of the compiled rules (swapped whole on save);
  - updates counters and timers first (rate-limited messages still count);
  - renders the request at arrival time;
  - pushes it to the lane.

  Secret values are read from the keychain into memory off that thread (`automation-header:<rule>:<name>`, and
  `automation-param:<rule>:<name>` for a secret query parameter such as `?key=`, masked in Test, never exported).
  Rules are in `automation.json` (config folder; the bridge binary uses `SPECTER_STUDIO_CONFIG`, else memory) and
  never hold a secret.
  - Commands: `automation_get|set|check|test|status|reset|resend|export|import|examples|secret_set|secret_status`.
  - `secret_get` still answers only page passwords.
  - `automation_test` works on a copy of the state and masks secrets.
- Not built: OAuth (the Google recipes need none), and per-rule rate limits set by the user (the limits are named
  constants).
- UI: `src/components/Automation.tsx`, a Settings section:
  - a rule list with on/off, counts, Activity, Reset and Delete;
  - "New from example" (escape room, haunted house, maze), Export / Import as text;
  - a rule editor checked as it is typed (`automation_check`) with "Test this rule" and "Send it once";
  - the bridge settings (status in plain words, the password shown only as set / not set).

  State helpers live in `src/automation.ts`. The bridge's settings stay in `prefs.bridge` (older settings read
  as out, `#`).

## Dashboard (runs and events)

- The show at a glance (`src/pages/Dashboard.tsx`): a tile per board (online, runs tonight, lifetime runs, last
  triggered as "2 min ago (21:04)", firmware and script badges), the fleet's runs tonight, a live event feed
  (runs with board and source, status, online / offline, settings changed, errors; filter by board and type,
  pause, clear) and past nights with runs per board. The board cards, the board page and the shared page show
  the same counts (`src/dashboard/RunCounts.tsx`, `core/src/viewer.html`).
- The counts are the firmware's (PROTOCOL.md "Run counters"): `runs_since_power_on` ("tonight": boards are
  powered up for a night's show and off afterwards) and `runs_lifetime` (kept on the board). Never per calendar
  day. A firmware without them still gets its runs in the feed (a show's `started` notice), without counts.
- Sources: boards with a direct session (their `run`, `notice`, `log`, `params_changed` ... events) and boards
  reporting to the fleet server (`core/src/mqtt.rs` passes each `<p>/event` on as `Event::FleetEvent`; online,
  state and status as before). A board that does both is shown once (matched by its topic label).
  `src/dashboard/DashboardWork.tsx` collects them whatever page is open.
- Nights (`src/dashboard/nights.ts`): a night starts at the first run after `NIGHT_GAP_MS` (4 h) without runs and
  is named after its evening (a first run before `NIGHT_STARTS_AT_HOUR`, noon, belongs to the day before), so a
  show from 7 pm to 2 am is one night. The feed is written every 2 s to `<library>/.specter/nights/<YYYY-MM-DD>.jsonl`
  (`core/src/nightlog.rs`: append, list, read; 8 MB per night at most); nothing is written without a library
  folder.

## Effect icons and runs on the cards

- **An icon and a colour per script and per effect, in comments** (`src/props/look.ts`), so they go to the board
  with the script and come back with `get_script` (the board's checker skips comments; no firmware change):
  `# icon: <name>` and `# color: <name or #rgb / #rrggbb>` (`colour`, `=` and any case work too) in the lines above
  the first effect, apart from the comments directly on top of it (a blank line between), are the script's; the
  same lines directly above an `effect …:` line are that effect's. An effect without its own takes the script's;
  the library list (`core/src/library.rs` `look`, same rules, one shared case table
  `tests/fixtures/look-cases.json`) takes the script's, else its first effect's. An unknown or missing icon is
  drawn as `play`, an unknown colour as the icon's own.
- **Icons** (`src/props/icons.tsx`): play, splat, drop, lightning, fog, bulb, sound, skull, ghost, bat, spider,
  fire, eye, door, star, bell (Material icons' paths, MIT, where one exists; the rest drawn here), and the
  colours red, orange, yellow, green, teal, blue, purple, pink, white, grey, black. Each is a disc in its colour with the
  shape in black or white (whichever has more contrast) and a thin outline in the theme's divider colour, so every
  colour shows on every theme; each carries its name (label and tooltip), so colour is never the only signal.
- **The editor's "Icon and colour"** (`src/props/LookPicker.tsx`) writes, changes or removes only its own comment
  line, for the whole script or one effect; the blocks view keeps comment lines as they are.
- **Extensions**: plugin.json `"icon": "icon.svg"` (the extension's own: its tab and the extension lists) and
  `"icons": [{"name": "lantern", "label": "Lantern", "file": "icons/lantern.svg"}]` (more names a script can use).
  Core (`plugins.rs` `icons`, command `plugin_icons`) reads only `.svg` files inside the extension's folder, at
  most 32 KB, 64 icons; Studio sanitizes them (`src/props/svg.ts`: shapes, geometry and paint only; no scripts,
  styles, links, images, `use`, entities or `url(`) and inlines them, never as script. An extension never
  replaces a built-in name.
- **Runs** (`src/props/runs.ts`, fed by `src/props/PropRunsWork.tsx` whatever page is open): a `run` event starts a
  run (`kind` script with the effect's `name`, show, or the built-in effect); the state ends it
  (`script.effects[].running`, `shows[].state`, the built-in effect's `pulsing` / `recovering`), gives a show its
  own `length_ms` / `elapsed_ms`, and starts one Studio did not hear begin. Boards reporting over MQTT the same
  way (`<p>/event`, `<p>/state` at most once a second); a board that does both is followed through its direct
  session. Kept by topic label, like the Dashboard.
- **The fill** (`src/props/PropCard.tsx` `CardFill`, `CardLook`; Boards page and Dashboard tiles): the card fills up
  in the effect's colour over the run's expected length, with the effect's icon, name and time left beside the
  board's name. The length (`runLengthMs`): from the line after the first `wait for`, the sleeps, fades and
  flickers one after another, and a pulse that outlasts them; a time named by a setting is read from the board
  (`get_params`, again after `params_changed`). A second `wait for`, a setting the board does not give, or a board
  Studio has no script for (MQTT only): a gentle sweep instead (a still half fill with reduced motion).
- **The trigger flash** (Dashboard, `TriggerFlash`): on a `run` event only (never a state read after a
  reconnect), the effect's icon covers the card for 1.2 s and fades; a newer start replaces it, nothing queues.
  With `prefers-reduced-motion` a still badge in the corner for the same time. Settings › Look turns it off
  (`prefs.triggerFlash`).

## Unsaved work (hot exit)

Like VS Code's hot exit: unsaved effect edits and typed-but-unsaved board settings are written to the library's
hidden folder, `.specter/unsaved.json`, 300 ms after the last change (`src/hotexit.ts` -> `unsaved_put` ->
`core/src/unsaved.rs`; the same path in the desktop app and in a browser through the bridge). The file has one
entry per computer (by host name), so a library in a sync folder or on a USB stick never restores another
computer's drafts, and it is written whole through a temporary file and a rename. Secrets typed into board
settings (the board marks them; key names with pass / pin / secret / token are dropped as well) are never
written.

- **Next start** (`RestoreNote`): "Restored your unsaved changes from last time", one line per item with Keep /
  Discard. Keep leaves it as an unsaved edit (save it from its page); an undecided item stays on disk, so a second
  crash loses nothing. Nothing is written before the restore has read the file (no startup race that erases it).
- **Conflicts**: each effect edit carries the hash of the text it started from. When the library's file changed
  since (saved again, here or on another computer), the note and the editor offer "Compare and pick…": both
  versions side by side, "Keep my changes" or "Use the library's version". An effect that is no longer in the
  library can be saved back. Restored board settings wait for the board with the same id (practice boards get a
  new key every start); when the board's own value changed since they were typed, its Settings tab says so and
  offers the board's values.
- **Which exits keep it**: a crash, a kill, the computer shutting down, or closing a browser tab (a tab cannot
  tell a reload from a close; the browser still asks first). Closing the desktop window with
  "Close without saving" discards the changes it named (restored settings for a board that never connected
  stay).

## Script sources (git)

The library's effect scripts can live in git repositories (`core/src/sources.rs`, `core/src/gitsync.rs`,
`src/components/ScriptsRepo.tsx`). Each source is its own clone in `<library>/sources/<folder>/` (its scripts in
`effects/`, or `.txt` files at its top); its scripts are named `<folder>/<script>` everywhere (index, history,
the header line on boards), so a plain name never collides with one. The folder is the repository's name
(`owner-name` when that is taken), the same on every computer. Settings › Scripts repository has one field:
`owner/repo` or `github:owner/repo` (GitHub), `gitlab:group/sub/repo` (GitLab, nested groups), `bitbucket:owner/repo`,
or any https / ssh address; the expanded address and folder are shown before cloning. More sources are added with
Advanced on. The library's own `effects/` stay where they are; after the first source Studio offers to copy them
in (never moves them).

- **Buttons**: Get latest (fetch, then fast-forward; a plain rebase only when the folder's own commits are already
  made; a conflict aborts it, so the folder is exactly as before) and Back up everything (add all, commit
  "Studio backup: 3 scripts changed", push; a rejected push gets the latest once and pushes again), for all
  sources and per source (side bar group, Settings, command palette).
- **Saving**: one writable source is "Save new scripts here"; with two or more writable sources a new script asks
  where it goes (closing keeps the default). An edited script saves back to its own source.
- **Read-only sources**: a dry run when the source is added, or the first refused push, marks a source Studio
  cannot push to (`.git/specter-studio-read-only`, this computer only; Check again clears it). The core refuses
  saves, renames, deletes and file writes in it; "Save a copy to…" puts a script into one of your own sources.
- **Remove** (Settings): deletes only the source's clone, after a confirm. With changes not backed up it says so
  and keeps the source unless "Delete anyway" is ticked.
- **Auto save** per source (off by default): after a save in Studio, 10 s of quiet (`AUTO_SAVE_QUIET`), then Back up
  everything for that source, off the UI thread, one git operation at a time. A failure is a quiet status-bar note.
- **Anything not automatic** (conflict, diverged history, sign-in refused, detached HEAD, a half-done merge or
  rebase): nothing is changed and one message says "Your scripts folder needs a git client to sort this out:
  <reason>. Folder: <path>." with Open folder. Never a force-push, `reset --hard` or discarded change.
- **git**: the system `git` with the person's own credential helper, ssh agent and identity (`GIT_TERMINAL_PROMPT=0`,
  ssh in batch mode unless they set their own ssh command, 120 s limit). A button the person presses (Get latest,
  Back up, adding a source or extension) lets the credential manager show its sign-in window (Git Credential
  Manager on Windows and macOS), with 10 minutes for it; what runs by itself (auto save, Check all for updates, the
  read-only check) never does (`GCM_INTERACTIVE=never`, `credential.interactive=false`, no askpass). Studio never asks for, stores or logs a
  password or token, refuses addresses with one in them, and never sets a name or email (none configured: it says
  how to set one). No git: it says how to install it on Windows, macOS and Linux. Half-written temporary files
  are kept out with `.git/info/exclude`; history copies stay in the library's `.specter/` (this computer).

## Extensions from git

Settings › Add extensions (`core/src/extensions.rs`, `src/components/GitExtensions.tsx`): the same one field
and shorthands. The repository is cloned into the app's config folder (`extensions/<folder>/`;
`SPECTER_STUDIO_EXTENSIONS_DIR` for the browser bridge) with the person's own sign-in, so private repositories
work. The extension is the folder with `plugin.json`: the clone's top or one folder inside (searched two levels
down; several: the person picks one; none: "This repository has no Studio extension"). Only the chosen folder is
loaded, never other plugin.json folders inside it (a folder that is itself a plugin is not searched further,
`plugins::list`); a repository holding several extensions is added once per extension, each in its own clone. An
id Studio already has is refused. The list shows where each came from, its commit, Get latest (fast-forward only; a commit made in the
folder is a git-client matter) and Remove (deletes the clone only, and forgets its consent). Check all for
updates fetches and says which have news; it never applies them. After an add or update the plugin list is read
again, so a plugin.json that asks for more meets the consent screen before its page or adapter loads. A plugin's
firmware list folder (inside its plugin folder) works from these clones unchanged.

## Firmware release source

Studio checks for firmware updates without any setup: the default source is the public firmware repository's
GitHub releases (`https://github.com/speck0413/specter-proptroller/releases`, renamed from `spectre-proptroller`:
the old address is read as the new one, and GitHub's redirects are followed; an empty `releases` preference
means this, so people who never chose anything get it too). The core asks GitHub's API
(`/repos/<owner>/<repo>/releases`) for the newest full release that carries `proptroller-firmware.json` as an
asset, or, while there is none, the newest such pre-release (owner 2026-10-24: release candidates stay
pre-releases on GitHub; drafts never count) (PROTOCOL.md "Releases"), reads that manifest and downloads each image
from its own asset address in the same release (checked against its SHA-256). The answer is kept for five
minutes (GitHub allows 60 unauthenticated requests an hour; every board's check would otherwise ask). Settings
names the source in plain words with **Check now**; another source (a GitHub releases page, a manifest's web
address or a downloaded release folder) is an Advanced setting. Offline, the message says that checking needs
the internet or a downloaded release folder. Tests never reach GitHub: `SPECTER_GITHUB_API` points the core at
a stand-in (`core/tests/releases.rs`, `tests/fixtures/github-mock.mjs` for the UI tests).

Trust (`core/src/fleet.rs`): a release list and its images come only over https or from a folder on this
computer (plain http only to this computer, and only while `SPECTER_GITHUB_API` names a test stand-in); a
redirect is followed only to another https address. Every image needs a `sha256` in the list, or it is not
installed. An update installs only a newer version than the board runs (`allow_older: true` to go back on
purpose; a switch of implementation is always allowed), and only from the release list (no arbitrary file).
Signed manifests: `RELEASE_KEY` (an ed25519 public key, hex) is empty until the releases are signed. Once it is
set, a manifest is taken only with a valid detached signature beside it, `proptroller-firmware.json.sig` (the
64-byte signature of the manifest file's exact bytes, hex): a release asset on GitHub, a file next to the
manifest in a folder, or `<manifest URL>.sig`. Signing a release: keep the private key offline (not in CI
secrets of a public repo), run `openssl pkeyutl -sign -rawin -inkey release.pem -in proptroller-firmware.json |
xxd -p -c 256 > proptroller-firmware.json.sig`, upload both; the public key's 32 bytes go into `RELEASE_KEY`.

## Record effect

The second way in the board page's "Make it do something…" dialog (beside "Fill in a form"), for people who
know PicoBoo's record mode. It works like Simon says: pick what starts it (TRIG1, TRIG2, USER1-3), press
**Start** (Space; an optional 3-2-1), then tap or hold big buttons named by the board's own names ("lamp (OUT1)",
keys 1-8; sounds on Q W E R when the board has sound) and slide a level for each dimmable output (OUT1-OUT4,
0-100 % in 5 % steps). Before Start, "Outputs to use" picks which outputs get buttons (all that a script may
use, by default). The real board does each one as you do it; the button
lights at once and also shows what the board reports (`board: on`), and the live tiles stay on the page under it.
**Stop** (Space) and the board does the whole take back once, straight away. Then: **Play it again**, **Try
again**, **Add more on top** (the earlier passes play on the board while the new pass is tapped over them),
"leave out the quiet bit before the first tap" (on by default), and **Keep it: save and send**. **Cancel** (top
right, at every step; Escape too) stops at once and lets go of every output the recorder touched; with something
recorded it asks "Discard this recording?" (**Discard** closes and saves nothing, **No, go back** shows the take
for review), with nothing recorded it just closes, and the focus goes back to "Make it do something…". The code is
`src/record/` (`take.ts` the types over the firmware's shared `firmware/web/take.js`, `RecordEffect.tsx` the
recorder). The phone page's Record effect uses the same take.js, so a take gives the same script in both
(`firmware/docs/RECORD-EFFECT.md`).

**One recorder.** The take becomes an ordinary effect script (`firmware/SHOW-SCRIPT.md`), saved in the library
like any effect and sent with `set_script`, so it can be opened and changed as text or as blocks afterwards, is
recognised on the board ("up to date"), and is backed up with the library. Firmware 0.1.0-rc.1 removed the
board's own recorder (`record_start` … `record_abort` and the USER-button learn mode; USER1-3 always trigger);
the shows panel offers its Record over / Add to it only on older firmware that still reports the `record`
capability.

**Take → script** (take.js `takeToScript`, unit tested in the firmware and in `take.test.ts`): absolute times are rounded to 0.1 s and written as the sleeps
between them (no drift over a long take); a hold lasts at least 0.1 s; holds of one output that touch or overlap
(a second pass) become one; offs go before ons at the same moment; a slider becomes `outN = NN%` lines (at most
one per 0.1 s) and a smooth movement `fade outN to NN% over S`; every output is off at the end (no
"still on" warning); sound taps become `audio_single = <file name>` (or its number) and are played live as
`sound play_folder N track 1`, which is what `audio_single = N` plays. One effect when it fits (64 lines);
otherwise one effect per output plus one for sounds, all waiting for the same input, so they still start
together (an output may belong to one effect only). Over the board's limits (8 effects, 256 lines, 8192 bytes)
it says so in plain words and nothing is saved. The board's own checker (`check_script`) runs before saving.

**Playback.** Nothing can start a script effect remotely (`run` is for shows), so the "board says it back"
playback is Studio driving the real outputs with `set_output` along *the timeline the script itself runs*
(take.js `timeline`: levels, fades in 0.1 s steps, sounds), so what you see is what you keep. After Keep, the board itself runs it on the
trigger; on a practice board "hold Press on TRIG1" tries it.

**Safety.**
- Requests for one output are chained, so a quick tap's "off" can never overtake its "on".
- Every output the recorder turned on is let go (`set_output` level `null`, back to whatever drove it before)
  on Stop, at the end of a playback, on Cancel (before it asks anything), when the page is left or the window hidden (`pagehide`, unmount),
  when the board is stopped (STOP stays on the page; the recorder ends the take and plays or records nothing until the board restarts), and when the board drops off
  (the take ends; every output it touched is let go again as soon as the board answers). When the window loses
  focus or is hidden during a count-in, a pass or a playback (timers may run late then), everything is let go and
  the take ends there; what was tapped so far is kept.
- Space starts and stops only from the recorder itself (its Start / Stop and tap buttons, or nothing focused): a
  focused control elsewhere, such as the board's Stop or Keep it, keeps its own Space.
- A hold never lasts longer than the board's maximum on-time for that output (`<output>_max_on_ms`, read with
  `get_params`; 0 = no limit): the recorder turns it off at the limit even while the finger stays down (the
  button says "off: max on-time"), the script gets the longest whole 0.1 s within the limit, and a note says
  plainly how long it was held and how long it will stay on. The board's own limiter (the output shaper) applies
  to manual outputs too.
- Only outputs a script may use are offered (role "shows", not owned by the pulse-and-recover effect); USER1-3
  always (on firmware before 0.1.0-rc.1 only with `buttons = triggers`: the entry says so), and TRIG2 not while
  it is set to pause.
- A board lets go of the outputs a session held when that session's connection closes, so a Studio killed
  mid-hold leaves nothing on (firmware before 0.1.0-rc.1: until the maximum on-time, STOP or a restart). Closing
  the recorder while the board is offline drops the "let go when it is back" step.

**Not possible yet.** "When the board starts" is listed but disabled: every effect starts with `wait for` an
input.

## Done (and how it is checked)

- Device layer: WebSocket and serial sessions (both reconnect), UDP/mDNS discovery, probe, practice boards,
  update with progress, rollback, the Pico install wait and implementation switches (backup on disk first),
  backups, release manifest, library, firmware projects, builds, flash plans (ESP32 esptool plan, Pico merged
  UF2), serial monitor, sounds, keychain, MQTT fleet server, bridge and viewer. `cargo test`: 101 tests, most
  against the real simulator; serial over pseudo-terminals; MQTT with a fake board and a second broker (the bridge both ways, loops, refused requests, reconnects); automation rules (patterns, templates, counters, timers, queue, retries, rate limit, secrets, the examples, a rule firing into a local web server); real
  PlatformIO builds for ESP32 and Pico W, including the Pico bootloader merge (skipped without PlatformIO).
- App: first run, boards grid and badges, board page (momentary controls, settings, backups, plot, activity,
  console), library with the effect editor (Monaco language with completion and hover help, blocks, live
  checker, practice board, send to one or all boards), own firmware (editor, Upload over Wi-Fi or USB with a
  confirmation, PlatformIO install offer, building bricks that generate the sketch), serial monitor and plotter,
  per-board and selected-board actions, plugins, wiring guides, sharing, the fleet server settings, six themes, text size, the command palette, back and forward.
  `npm test`: 432 unit tests (automation rules and bridge settings, every theme's contrast, the palette filter, shortcuts, blocks round trip on all 84 golden and example scripts, the C++ generator, hot exit,
  STOP on locked boards, test-output let-go retries, plugin permissions, shows).
  `npx playwright test`: 71 end-to-end tests (an automation rule made, tested and fired into a local web server, a "may have been sent" request sent again, editing and sending a board's script from its page, the library
  round trip and the narrow layout among them), the wiring-guides one skipped without the guides (hot exit after a reload, the board's shows on old and new firmware, one story from first run to firmware build, blocks to a build,
  page lock, plugins, serial monitor, sharing, no technical words in beginner mode, axe in every theme, the shell (palette, back/forward, side bar, themes, text size), and
  the built app under the desktop window's Content Security Policy; the wiring-guides test runs when
  `SPECTER_GUIDES_DIR` is set). `scripts/test-plugin-isolation.sh` (needs a display) proves on the release build
  that a plugin frame cannot reach Tauri's IPC (Tauri refuses its null origin).

## Firmware types

A board reports which firmware it runs (`info.fw`, also in its mDNS TXT record): `generic` for the stock firmware,
another name for other firmware. Studio knows one type itself, **Generic (stock)**, whose list is the release
source above. A plugin adds more in its plugin.json (`core/src/fwtypes.rs`):

```json
"firmware": [{"fw": "demo-lamp", "name": "Demo lamp", "source": "releases"}]
```

Images are matched on type + board package + chip: `fw`, `board` (the board package, BSP, the firmware was built
for: `info.board`, mDNS TXT `board`; a board or list entry without it is `proptroller`, the Proptroller board) and
`mcu`. One type can so carry builds for several boards with the same chip; a list entry may name its board package
for people (`board_name`, shown in the "Kind of board" dropdown).

`fw` is the name the boards report (lower case, digits, `-`, `_`), `name` what the person sees, and `source` the
type's own release list: an https GitHub releases page or manifest address, or a folder inside the plugin's folder
(no absolute paths, no `..`). The list has the same format and the same trust rules as the stock one (https or a
folder, a SHA-256 for every image). A plugin's types count only once the person allowed it: offering firmware is a
line on its consent screen ("Offer firmware for your boards: …"), and Settings > Firmware updates lists each
extension's types with **Allow…** (the same consent screen; a plugin that only offers firmware has no tab). A
plugin may only add types: `generic`, a type listed before it, or images in its list for any other `fw` are
ignored, so it can never replace the stock firmware or another plugin's. One list that cannot be read is reported
on its type and never hides the others.

- **The generic release that comes with Studio**: the desktop app bundles the generic images (ESP32 DevKit, and
  Pico W / Pico 2 W in CI builds) and their manifest, built from the firmware submodule at build time
  (`scripts/bundle-firmware.py`, run by `scripts/build-desktop.sh` and CI; `src-tauri/bundled-firmware/`, found
  through `SPECTER_BUNDLED_FIRMWARE`). Generic (stock) with the built-in Proptroller board is so always offered,
  offline and before any release is published; a downloaded release is used instead when it is the same version or
  newer (Allow betas applies to the download), and the dropdown says "<version> comes with Studio" while the bundled
  one is used (`fwtypes::prefer`). A downloaded list can never name the bundled folder.
- A list that has nothing published shows its type as "No release published yet" (not selectable). When the USB
  install has no firmware image at all for the chosen type, it says "No firmware found yet (no release published)."
  with **Choose a folder…** (a release folder becomes the release source), never an empty grey box.
- A board without over-the-air updates (no `update` in its info: the plain Pico, firmware without update support)
  is never offered an update it would refuse: `update_plan` answers `usb_update: true` instead of `out_of_date`, and
  its badge says the new version goes on over USB (Put firmware on a new board).
- `firmware_types {source, plugins}`: the types (`plugins`: the ids of the allowed plugins, from the UI).
  `firmware_catalog`: every list merged, `{types: [{fw, name, plugin, version | error}], images}`, each image with
  its own list's `version` and `source` (the stock firmware and a plugin's are numbered on their own).
- Updates follow the board: `update_plan` and `update` read the list of the type the board reports (and say its
  `type_name`); a board whose type Studio has no list for is offered nothing. A plugin's `updateFirmware` request
  never changes the type.
- Changing the type is deliberate: `update` with another `fw` is refused unless `switch_type: true` comes with it.
  On a board's page **Change board package / setup…** has the firmware image dropdown (for boards that take
  updates over Wi-Fi, once an extension adds a type), then a confirmation naming both types. The board's settings are saved to the
  backups folder first when it can give them, and not put back (another firmware keeps its settings its own way). A
  type switch may go to a lower version number (the numbers belong to different firmware).
- **Start fresh with this firmware's defaults** (owner 2026-10-24): a firmware's own board defaults (a board
  package's `proptroller_defaults.h`) apply only on a fresh board, so after a type switch, over Wi-Fi or USB
  (ESP32: Studio connects on the same port), Studio offers it, and Change board package / setup… has it as a
  separate action (with "also forget the board package", the board's `factory_reset` `forget_board`).
  Each time confirmed first; it is the board's `factory_reset` (settings, shows, script, page password and Wi-Fi
  erased; the board restarts), so the board leaves the Wi-Fi and is set up again through its own Wi-Fi or USB.
  Never done by itself. Plugins cannot send it (Studio's plugin rules are unchanged).
- **Start fresh where people look for it** (`src/freshStart.ts`, `src/components/StartFresh.tsx`): Studio remembers,
  per board id, the firmware type and board package it last saw the board run (`firmwareSeen`; a board seen for the
  first time is remembered as it is). When a board runs another one (another firmware image, over Wi-Fi, USB or by
  hand, or another board package), its card and page show "This board now runs <type>. Its stored script and
  settings are from the previous firmware. Start fresh to load <type>'s defaults?" with **Start fresh…** and **Keep
  mine** (remembered per board, firmware and board package, `freshKept`). The board's Settings tab always has
  **Start fresh (this firmware's default settings and script)…**. Both open the same dialog: **Keep its name and
  Wi-Fi** (on by default). Firmware with the `defaults` capability keeps them itself: `factory_reset {"keep_wifi":
  true}` keeps the name (so its `name.local`), the network and its password and the setup hotspot's password, and
  the board comes back on its network; Studio waits for it there. Older firmware gets them back from Studio: it
  reads the name and network, the person types the Wi-Fi password again, and after the `factory_reset` Studio
  sends them with `set_params` once the board answers on the same connection (always over USB, over Wi-Fi only
  while it can still reach it, else it says what to set again), **Also forget the
  board package** (`forget_board`), and what the board package's own defaults hold when an extension's package file
  has the running package's id (`board_files` `defaults`: settings, profile, script). Installs and package changes
  end with the same offer: the banner (the board now runs something else) or the message's Start fresh button.
- **A board on USB moving to the generic image** picks its board package in the same dialog (the board's presets
  when it can list them, else the release's, and the extensions' files): it goes on in the same esptool write as a
  file system image (a built-in preset as the board gives it with `get_board` `preset`; the Proptroller board as a
  fresh file system), so the board never runs another pin map. The board's settings are backed up first, and its
  name and Wi-Fi network are given back afterwards (the password typed in the dialog).
- **The script after a change of firmware**: an update of the same firmware keeps the board's script, with no
  question. After a change of type or board package, when the new one has its own script (`get_defaults`, firmware
  capability `defaults`; named by its `script_name`), the banner asks first: "<new> comes with its own script
  (“<name>”). Use it, or keep the script that's on the board now?" with **Use <new>'s script** and **Keep my
  script** (Start fresh… stays beside them). Using it saves the board's script to Your library first unless it is
  there unchanged (and says where), then `apply_defaults {only: ["script"]}` (with `"profile"` when the defaults have
  one): the other settings, Wi-Fi and name stay. Without a script of its own nothing is asked about the script.
- A new board's first firmware: **Add a board > Put firmware on a new board (USB)** has the firmware image dropdown
  (stock first, then the extensions' types; a type without a USB image is shown but cannot be picked), the kind of
  board (from that type's USB images), the board package, profile and script (Board packages below), the USB port
  (ESP32) or BOOTSEL drive (Pico), and **Install** after a confirmation. `usb_install {fw, board, mcu, port | drive, confirm, dry_run}` takes the type's `first_flash` image
  (PROTOCOL.md "Releases"), checks its SHA-256, and writes it: the ESP32's merged image from 0x0 with esptool, a
  Pico's UF2 copied to the BOOTSEL drive with the chip check (`flash::release_plan`, `flash::run`). From then on the
  board reports its type and updates follow it.

Tests: `core/src/fwtypes.rs` (merge, type pick, refusal), `core/tests/devices.rs`
`a_plugin_adds_a_firmware_type_and_a_switch_needs_a_confirmation` (a plugin folder, a practice board, a dry-run USB
install), `src/firmware.test.ts`, `tests/e2e/firmware-types.spec.ts` with the test extension
`tests/plugins-e2e/firmware-demo` (never presses Install: a real board may be plugged in).

## Board packages

The generic firmware is one image per chip; which board it runs on is data, a **board package** (the firmware's
BOARD-PACKAGES.md): which pins drive which terminals, plus the board's own defaults (settings, profile, script).
Firmware that takes packages lists `board_package` in `info.capabilities`; `info.board` names the package it runs
(`none` when a stored one was refused and no pins are driven). `get_board` says what runs, what is stored and the
built-in presets; `set_board` stores a package, a preset or forgets the stored one, and the board keeps its old pins
until it restarts. Studio does not check pins: the board does, and its words are shown as it said them
("The board did not take the board package: board package: OUT1: GPIO 35 is input-only …").

An allowed extension may offer files inside its own folder (no absolute paths, no `..`; `core/src/boardpkg.rs`):

```json
"board_packages": ["board-packages/demo-lamp-board.json"],
"profiles": [{"name": "Lamp words", "file": "profiles/lamp-words.json"}],
"scripts": [{"name": "Lamp on when pressed", "file": "scripts/lamp-on.txt"}]
```

Offering them is a line on the extension's consent screen ("Offer for your boards: …"), and Settings > Firmware
updates lists them with **Allow…**. A package is shown by the `name` in its JSON, with the extension's name as a
note; Studio checks only the envelope (one JSON object, `"board_package": 1`, an `id` and a `name`, at most 16 KB),
a profile is one JSON object (at most 12 KB), a script text (at most 8 KB). A file that is missing or wrong is listed
with the reason and cannot be picked; a package for another chip cannot be picked either.

- `board_files {plugins}`: `{packages, profiles, scripts}`, each `{plugin, file, name, error?}` (a package also
  `id`, `mcu`, `base`).
- `board_setup {plugins, package: {preset} | {plugin, file} | {forget: true} | null, defaults, profile?, script?}`:
  the requests in order (`set_board` with `"defaults": "apply"` when asked, `set_profile`, `set_script`), whether a
  restart is needed, and the `reboot` request. The UI sends them one by one with the page password, stops at the
  first refusal, and asks **Restart now to use the new board package?** before it sends `reboot` (also when a
  later part was refused after the package was stored). A profile or script alone needs no restart.
- **Change board package / setup…** on a board's page: the board package (keep the one it runs, its presets, the
  extensions' files, forget the stored one), "also start with the board package's own settings, profile and
  script" (on by default; Wi-Fi is kept), profile and script ("None (keep the board's)"). Nothing is flashed. For
  firmware without `board_package` the package choice is replaced by the reason (its board is built in).
- USB install with the generic image: a built-in preset (default: the Proptroller board, or the release entry's
  `presets`) is sent over the same USB session once the firmware answers (ESP32), with the profile and script,
  then `reboot`; the default preset with no profile or script sends nothing. A package **file** goes on in the
  same write: a LittleFS image holding only `/board-a.bin` at the file system offset (`core/src/fsimage.rs`, the
  firmware's FLASH-MAP.md "A board package in the first flash"): an esptool part at 0x3D0000 for an ESP32, its
  blocks added to the UF2 for a Pico. The chosen profile and script go into the package's defaults when the record
  still fits the board's 4048-byte store, else they are sent once the board answers. Writing the file system
  replaces the board's settings, Wi-Fi, shows and script: the install says so first, Studio saves a backup when
  the board answers before the write, and afterwards offers to put its name and Wi-Fi network back (the password is
  typed again; it is never in a backup). An extension's image type has its board built in: no board package then.
- Over the air: a board on a package the new generic image does not have built in (`info.board` not in the image's
  `presets`, default the Proptroller board) whose firmware lacks `board_package` is never moved to it:
  `update_plan` answers `usb_update` with `usb_reason` ("… install over USB so the board package goes on with it")
  and `update` refuses with it. Firmware with `board_package` takes the generic image and keeps its stored package.
- `fs-image` (bench): `cargo run -p studio-core --bin fs-image -- --mcu esp32-devkit --package pkg.json --out
  fs.bin` writes an image (and says its offset); `--read fs.bin` mounts one and prints its package.

Tests: `core/src/boardpkg.rs` and `core/src/fsimage.rs` (paths, envelope, request order, the update refusal; the
image mounted with each chip's geometry, the firmware's record fixture read back and packed byte for byte, UF2
blocks), `core/tests/devices.rs` `an_allowed_plugin_offers_board_packages_profiles_and_scripts` (dispatch and a
dry-run USB install with the image), `src/boardPackages.test.ts`, `tests/e2e/board-packages.spec.ts` against a
practice board with the test extension `tests/plugins-e2e/board-files-demo`.

## Not done / limits

- **MQTT end to end with a real board or simulator**: the simulator has no MQTT client yet, so the fleet server
  is tested with a fake board speaking the protocol's topics.
- **USB first flash has not touched hardware** (by rule tonight): ESP32 uses esptool from PlatformIO's
  packages with the exact FLASH-MAP plan (tested as dry runs and against a real build's files); Pico W / Pico 2 W
  get the bootloader built and the firmware's own merge run (`tools/picoboot_image.py merge`), and the merged
  `flash.uf2` is copied to the BOOTSEL drive (the layout is checked byte by byte in a dry run). The
  `espflash` crate was not used: PlatformIO is required for building anyway and already brings esptool, and it
  avoids a second flasher and libudev.
- Installing a *release* over USB (Firmware types) has been tested as dry runs only, not on a board.
- The board package file system image has been mounted by the C littlefs and littlefs-python with each chip's
  geometry, not yet read by a board.
- Own firmware builds in a hidden PlatformIO project per sketch (`.specter/build/<sketch>/`, `src_dir` = the
  sketch) with the same flags as the firmware's workspace build (`PROPTROLLER_FW_NAME` = the sketch folder,
  `PROPTROLLER_FW_VERSION` = its `VERSION` file, plus Studio's `PROPTROLLER_FW_BUILD` id as a fallback for older
  firmware). The hidden project's board sections come from the firmware's `workspace-template/platformio.ini`
  (its `project_src.py` replaced by a do-nothing script: `src_dir` names the sketch), or from `template/` of
  older firmware. The library folder also gets that `platformio.ini`, `project_src.py` and `make_envs.py`,
  written by the same rules (checked with `make_envs.py --check`), so it opens and builds in VS Code too.
- QEMU as a device: not hooked in (the firmware's `tools/qemu/run-esp32.sh --net` runs an emulated ESP32 on the
  network; Studio could add it as a board by address).
- Google Drive APIs for backups: not done; any synced folder works. Git repositories: see Script sources.

## Firmware asks

1. An MQTT client in the simulator (so the fleet-over-MQTT path can be tested with real boards' code).
2. Done: release first flash over USB from the manifest's `first_flash` images (Firmware types).
3. `tools/qemu/run-esp32.sh --net` for an emulated ESP32 device.
4. An event when a board's script or settings change through another client already exists; a `boards`-level
   "hello" with the script's hash in `info` would save a `get_script` per board on large fleets.

## Roadmap (the whole IDE)

1. **Now**: boards, library, effects (text + blocks), practice boards, updates, backups, serial monitor and
   plotter, own firmware (text or blocks) upload over Wi-Fi or USB, plugins, MQTT fleet server, bridge, sharing.
2. **Next**: the fleet-commander pieces (several bridges with counters, broker monitor, external broker,
   observer password, headless mode on an always-on box, hotspot joining); move
   the submodule to the firmware's new beginner API; QEMU device; effect timeline view.
3. **Then**: debugging with breakpoints on the simulator (and QEMU); shared libraries for teams (GitHub / Drive
   sync helpers); show-wide timelines across boards.

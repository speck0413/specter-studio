# Specter Studio

A desktop app for Specter Proptroller prop controllers, for people who build haunted houses, theatre effects and
Christmas light shows, whether or not they write code. Find your boards, write effects, try them on a practice
board, send them to boards, keep every board up to date, and (in Advanced mode) write your own firmware.

- **Boards**: every board in one grid with two badges, *Firmware* (up to date / update available / your own
  firmware and its version) and *Effect script* (up to date / newer version in your library / not in your
  library / none). A board's page shows its live inputs and outputs (beside the other sections on a wide window)
  and its effect script in the library's editor, editable in place: **Save and send**, **Send to this board
  only** or **Save to library only**, with **Open in Your library** and **Compare with Your library** one click
  away (and the library's "Boards running" list opens a board's script). Hold-to-test buttons, settings with the board's own labels,
  backups, an activity log, a live plot of the board's values. **Record effect**: tap or hold a board's outputs and the board copies
  you live, then repeats it on its trigger; the take is saved as an ordinary effect script. Boards are found on the network, by address,
  through the board's own Wi-Fi, over USB, or added as practice boards that run on this computer.
- **Your library**: one plain folder (default `Documents/Specter Studio/My Props`) with `effects/` (one effect
  script per `.txt` file), `firmware/` (your own Arduino sketches, `<name>/<name>.ino` + `sketch.yaml`),
  `patterns/` (LED patterns, one `.pattern.js` file each) and
  `sounds/` (numbered 1-99 in name order; effects play them by name; one button copies them to the SD card). Copy it to a USB stick or a Dropbox /
  Google Drive / OneDrive folder; nothing else is needed. Effect scripts can also come from and be backed up to git repositories
  (Settings › Scripts repository: Get latest, Back up everything, Auto save; more sources under Advanced). Effects are edited as text and as blocks side by side,
  checked as you type by the board's own checker, tried on a practice board, and sent to one board or all boards
  running an older version.
- **LED patterns**: small programs that colour an LED strip light by light, written in a JavaScript-like pattern
  language, with a live preview strip (60 frames a second, the pattern's sliders and colour pickers under it) and
  plain messages for mistakes and endless loops. Kept in the library's `patterns/` folder as `<name>.pattern.js`;
  a pattern file (`.epe`) exported from your own controller can be imported. See `docs/DESIGN.md` (LED patterns).
- **Icons and runs at a glance**: each effect script, and each effect in it, can have an icon and a colour (splat,
  skull, ghost, bat, lightning, fog ... picked in the editor and kept as `# icon:` / `# color:` comment lines, so
  they go to the board with the script). Board cards fill up while an effect runs, and on the Dashboard a card is
  covered by the effect's icon for a moment when it starts (a still badge with reduced motion; Settings › Look).
- **Serial monitor and plotter**, the Arduino way: friendly port names, speed, send a line, reconnects after a
  reset; numbers on each line are plotted.
- **Upload**: one button builds your own firmware (PlatformIO behind the scenes) and puts it on a board over
  Wi-Fi (an update that rolls back if the new firmware fails) or USB.
- **Building bricks for your own firmware**: Blockly blocks for the Proptroller library that make the sketch.
- **Fleet server**: boards can report to Studio (MQTT); "Share with others" gives a read-only page anyone on the
  network can open.
- **Automation**: "when a message arrives on … send a web request to …" rules (a row in a Google Sheet per
  check-in, with counts and times), and a connection to another MQTT server, out, in or both ways (below).
- **Firmware and board packages**: putting firmware on a new board over USB picks a firmware image (*Generic
  (stock)*, one per chip, or a type an extension adds with its own release list), a board package (which pins
  drive which terminals: one built into the firmware, or a file an extension offers), and optionally a profile
  and a script. Each board then gets the updates of the firmware it reports. **Change board package / setup…** on
  a board's page sends another board package, profile or script over its connection (no flashing) and asks before
  the restart.
- **Plugins**: specialised clients in their own folders, shown in a sandboxed frame; they can also add firmware
  types and offer board packages, profiles and scripts (see `docs/DESIGN.md`).
- **Help**: the wiring guides that ship with the firmware.

## Automation: send check-ins to a spreadsheet

Settings, **Automation**. A rule says: *when a message arrives on* a topic, *send a web request to* an address.
It is meant for paperwork that should do itself, such as a row in a Google Sheet each time a room reports that
a group finished. Rules listen to Studio's MQTT server, so turn on "Boards report to this computer" first.

**Topic patterns.** Levels are split by `/`, and a leading `/` changes nothing.
- `*` is any one level.
- `{roomName}` is any one level, kept as `roomName`.
- `#` (or `**`) at the end is everything below.

`checkin/*/{roomName}/complete` listens on `checkin/+/+/complete` and hands `roomName` to the request. Studio
says in plain words what is wrong with a pattern: an empty `{}`, a name used twice, or `#` that is not last.

**Values in the address, headers and body.**

| Value | What it is |
|---|---|
| `{roomName}` (any name from the pattern) | the topic level that name stands for |
| `{topic}` | the topic |
| `{payload}` | the message as text |
| `{payload.people}` | a field of a JSON message; empty, with a note in the rule's activity, when it is missing |
| `{timestamp}` | local time with its offset, for example `2026-10-24T21:04:05-05:00` |
| `{date}`, `{time}`, `{unix}` | the date, the time, and seconds since 1970 |
| `{event_id}` | a unique id for this message and rule, the same when the request is sent again (so a sheet can skip a row it already has) |
| `{count.inside}`, `{count.inside[roomName]}` | a counter, or its value for this message's room |
| `{elapsed}`, `{elapsed_text}` | the time since the matching start, in seconds and as `12 min 05 s` |
| `{started_at}` | when the matching start came in |
| `{sequence}` | the group's number for that room today |

- Values are escaped for where they go:
  - quotes for a spreadsheet (CSV) line;
  - JSON escaping;
  - URL encoding in the address and in form bodies.
- A CSV value that a spreadsheet would read as a formula (`=…`, `+…`, `@…`) gets a leading `'`.
- A value Studio does not know is an error when you save, not when a message arrives.
- A value cannot go in the server name. The server is fixed when you save.

**Counters and timers (optional, per rule).**
- **Count** up or down a named counter. It changes by 1, or by a number such as `{payload.people}`, and it never
  goes below 0. It can keep one value per room (`for each roomName`).
- **Time each group**: a start rule marks the time for a room, and a finish rule picks the start it belongs to.
  That is either *the latest start* (one group at a time, as in an escape room) or *the oldest open start*
  (groups go through in order, first in, first out, as in a haunted house).
  - A finish with no start still sends, with the time empty and a warning in the activity.
- Counters and timers are kept on disk, so a restart loses nothing. **Reset counts and timers** starts them
  again from zero.

**Test this rule.** Type a sample topic and message to see the values that matched and the exact request, with
secret values masked. **Send it once** sends it for real.

**Delivery.** Studio never waits on a request: the MQTT server and the window stay quick.
- Each address (its server and path) has one queue, sent one at a time in order, so a start row always lands
  before its finish row in the same sheet. Another address is never held up.
- At most 1000 requests wait in all; then the oldest is dropped and counted. Waiting requests are kept on disk
  (`automation-queue.json`, owner-only, without secret values), so they are sent after a restart.
- A rule sends at most 10 at once, then 60 a minute. Messages over that still count and time, but their request
  is skipped and counted.
- A request may take 10 s. Studio tries again by itself only when it is safe:
  - when nothing reached the server (it could not connect, the name was not found, the secure connection
    failed): after 2 s, 4 s, 8 s and 16 s;
  - when the server says it is busy (429 or 503): after the time it asks for (`Retry-After`, at most 120 s),
    else on the same steps.
- A timeout or another server error (5xx) may already have added the row, so it is not tried again. The rule's
  **Activity** says "may have been sent: check the sheet" and has a **Send again** button. Other refusals (4xx)
  are not tried again either, and have the same button. A request sent again keeps its `{event_id}`.
- The last 20 results of each rule are under **Activity**.

**Secrets.** Three things go to the system keychain:
- header values marked *secret*;
- the *secret part of the address*, a query parameter such as `key` (`?key=…`), added to the address only when
  sending;
- the other server's password.

Studio shows them only as "set" or "not set", masks them in Test, never logs them, and leaves them out of
exports. Rules, counters, timers and waiting requests live in Studio's config folder (`automation.json`,
`automation-state.json`, `automation-queue.json`, owner-only permissions) and hold no secret values.

**New from example** adds a start rule and a finish rule for each of three cases. They send CSV lines that start
with `{event_id}`, and listen on `checkin/*/{roomName}/start` and `…/complete`. Their secret part of the address
is `key`, the word the script below checks. They start switched off: in each one, paste your address, set the
key, then switch it on.

| Example | Start sends | Finish sends |
|---|---|---|
| Escape room (one group at a time) | `{event_id},{roomName},start,{timestamp},{sequence},{payload.people}` | `{event_id},{roomName},complete,{started_at},{timestamp},{elapsed_text},{payload.people}` |
| Haunted house (in order) | `{event_id},{roomName},start,{sequence},{timestamp},{payload.people}` | `{event_id},{roomName},complete,{sequence},{started_at},{timestamp},{elapsed_text}` |
| Maze (many inside at once) | `{event_id},{roomName},entered,{timestamp},{count.inside[roomName]}` | `{event_id},{roomName},left,{timestamp},{count.inside[roomName]}` |

### Google Sheets with Apps Script (no sign-in in Studio)

1. In the Sheet, open **Extensions, Apps Script**, replace the code with the script below, put your own long
   word in `KEY`, and save.
2. **Deploy, New deployment**, type **Web app**:
   - *Execute as*: Me;
   - *Who has access*: Anyone.

   Copy the address that ends in `/exec`.
3. In Studio, make a rule (or add an example):
   - paste the address;
   - choose *A line of a spreadsheet (CSV)*, starting with `{event_id},`;
   - set *Secret part of the address* to `key` and its value to the same word;
   - switch the rule on.

```js
// Adds each CSV line Studio sends as a row of the sheet named "Log" (else the first sheet).
// The first column is Studio's event id: a line sent again (after "may have been sent") is skipped.
var KEY = 'put-your-own-long-word-here';

function doPost(e) {
  if (e.parameter.key !== KEY) return ContentService.createTextOutput('wrong key');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var book = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = book.getSheetByName('Log') || book.getSheets()[0];
    var seen = {};
    if (sheet.getLastRow() > 0) {
      sheet.getRange(1, 1, sheet.getLastRow(), 1).getValues().forEach(function (r) { seen[r[0]] = true; });
    }
    Utilities.parseCsv(e.postData.contents).forEach(function (row) {
      if (seen[row[0]]) return; // already in the sheet
      seen[row[0]] = true;
      sheet.appendRow(row);
    });
  } finally {
    lock.releaseLock();
  }
  return ContentService.createTextOutput('ok');
}
```

The web app answers with a redirect, which Studio follows; the row is added either way.
- The key keeps strangers who find the `/exec` address from adding rows. Studio keeps it in the keychain and
  adds it only when sending.
- The lock stops two requests at the same moment from both adding the same event.
- The Sheet can do its own sums (for example `=AVERAGE` over a time column), but Studio already sends the time
  taken and the counts.

A ready-to-copy rule for **Import rules** (Settings, Automation). It does this example:
`checkin/*/{roomName}/complete` sends `{roomName},complete,{timestamp}`, after the event id. After importing,
open the rule, paste your `/exec` address and set the key's value (secret values are never in an export).

```json
{"specter_automation": 1, "rules": [{"id": "checkin-complete", "name": "Check-in complete", "enabled": true,
  "pattern": "checkin/*/{roomName}/complete", "method": "POST",
  "url": "https://script.google.com/macros/s/PASTE-YOUR-SCRIPT-ID/exec", "secret_param": "key",
  "headers": [], "body": "{event_id},{roomName},complete,{timestamp}", "content_type": "csv"}]}
```

### Google Forms (no script at all)

1. In the form, use **⋮, Get pre-filled link**, type something in each answer, and copy the link. It holds
   `entry.123456=…` for each question.
2. Make a rule:
   - *Send a*: POST;
   - the address is the link up to `viewform`, with `formResponse` in its place
     (`https://docs.google.com/forms/d/e/FORM-ID/formResponse`);
   - *Body*: *A web form*;
   - *What to send*: `entry.111111={roomName}&entry.222222=complete&entry.333333={timestamp}`, with your form's
     numbers.

Each message becomes a form response in the form's linked Sheet.

### Connect to another MQTT server

Settings, Automation, **Connect to another MQTT server**:
- address, port, TLS, user name and password (keychain);
- the topics to pass (`#` is everything);
- an optional prefix on the other server;
- the direction: from Studio to that server, from that server into Studio, or both.

A message never goes back where it came from. The status reads "Connected", or "Not connected: *the reason*.
Trying again in *N* s". Requests to boards that come in from that server (`rpc`, `config/set`, `control`, …) are
refused unless "Let that server send requests to the boards" is on.

Messages the other server had stored (retained) come into Studio, but they do not fire automation rules. They
come again on every reconnect, so they are not news.

## Quick start (development)

From a computer with nothing installed to Studio running and a blank ESP32 DevKit on the stock firmware. The
same steps with more explanation, and the Windows and Linux notes, are in the firmware repository's
[docs/DEV-SETUP.md](https://github.com/speck0413/specter-proptroller/blob/main/docs/DEV-SETUP.md).

**1. Tools (macOS, once).** Apple's Command Line Tools and Homebrew (it asks for your password; paste the two
"Next steps" lines it prints):

```sh
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

**2. Clone** (with the firmware submodule):

```sh
mkdir -p ~/specter && cd ~/specter
git clone --recurse-submodules https://github.com/speck0413/specter-studio.git && cd specter-studio
```

**3. Set up and start:**

```sh
scripts/setup.sh                # tools, Rust, the firmware submodule, npm ci, the practice board
export PATH="$(brew --prefix rustup)/bin:$PATH"                          # macOS: Homebrew's Rust, now
echo 'export PATH="$(brew --prefix rustup)/bin:$PATH"' >> ~/.zprofile  # macOS: and in new terminals
npm run tauri dev               # the desktop app (the first build takes several minutes)
```

`scripts/setup.sh` checks and installs git, Node.js 20+, Rust (rustup), PlatformIO in `~/.platformio` (the official
installer; Studio's USB install runs esptool from there), esptool and Tauri's system parts, printing each one. It
installs only into your home folder (and Homebrew on macOS); anything that needs sudo it prints for you to run.
It is safe to run again; `scripts/setup.sh --check` installs and changes nothing, `--tools` stops after the tools.
On Linux it prints the `apt` / `dnf` / `pacman` line for WebKitGTK 4.1 when that is missing. Windows:
`powershell -ExecutionPolicy Bypass -File scripts\setup.ps1` (check), then with `-Install` (winget; Windows asks
for administrator approval for the C++ Build Tools and some others), and start Studio from Git Bash; there is
no practice board on Windows yet. Building Studio also needs libclang (docs/BUILDING.md, "libclang for the board
package image"; setup.sh / setup.ps1 check it): Linux `libclang-dev`, macOS the Command Line Tools (else
`brew install llvm` and `LIBCLANG_PATH`), Windows `winget install LLVM.LLVM` and `LIBCLANG_PATH`. Homebrew's rustup is keg-only, hence the two macOS `PATH` lines (once).

**4. Your own firmware build (optional).** Studio comes with the stock ESP32 DevKit firmware (the first
`npm run tauri dev` builds it from the firmware submodule) and also reads newer releases from GitHub. For the Pico W
boards, or to install a firmware you built yourself, build a release folder in a second terminal and point Studio
at it:

```sh
cd ~/specter/specter-studio/firmware/firmware/arduino
~/.platformio/penv/bin/pio run -e esp32dev -e picow -e pico2w -e boot_rp2040 -e boot_rp2350
~/.platformio/penv/bin/python tools/picoboot_image.py merge pico-w
~/.platformio/penv/bin/python tools/picoboot_image.py merge pico2-w
~/.platformio/penv/bin/python tools/release.py ~/specter/release --version 0.1.0-rc.2
```

In Studio turn on **Advanced** (top bar), then **Settings → Firmware updates → Folder…**, choose
`~/specter/release/assets`, **Use it**.

**5. A blank ESP32 DevKit.** Plug it in by USB. **Boards → Add a board → Put firmware on a new board (USB)**:
**Generic (stock)**, **ESP32 board · Proptroller board**, its port, **Install**.

**6. Use it.** **Plugged in with USB → Connect** (or join its Wi-Fi `Proptroller-XXXX` and **Connect through the
board's own Wi-Fi**). The phone page is http://192.168.4.1/ on that Wi-Fi. Open the board, type an effect script
and **Send to this board only**.

Without Studio: `~/.platformio/penv/bin/python ~/.platformio/packages/tool-esptoolpy/esptool.py --chip esp32
--port <port> write_flash 0x0 ~/specter/release/assets/first-flash-esp32-devkit-0.1.0-rc.2.bin`.

By hand, the checkout part of setup.sh is `git -c protocol.file.allow=always submodule update --init` (a sibling
clone works as the remote), `npm ci` and `scripts/build-sim.sh` (the practice board: the firmware's own
simulator build; run it again after firmware changes).

In a browser instead (the same app; the device layer runs as a small local service):

```sh
npm run bridge &                # the device layer on 127.0.0.1:18790
npx vite                        # http://localhost:1420/
```

The bridge wants a token in its WebSocket address; it writes it to `<temp>/specter-bridge-18790.token` and the
dev server picks it up from there (or set `SPECTER_BRIDGE_TOKEN` for both).

The bridge loads the repo's example plugins (`plugins/`) only with `SPECTER_STUDIO_EXAMPLE_PLUGINS=1`
(`SPECTER_STUDIO_EXAMPLE_PLUGINS=1 npm run bridge`); the Playwright tests set it.

## Tests

```sh
cargo test                      # device layer against the real simulated board: sessions, discovery, serial,
                                # updates and rollback, backups, library, flash plans, a real firmware build
npm test                        # effect-script blocks round trip (every golden case), language, C++ preview
npx playwright test             # the whole app in Chromium against the device layer and simulated boards
                                # (CHROMIUM=/path/to/chrome; SPECTER_GUIDES_DIR=... also runs the wiring guides test)
```

## How to demo

Start `npm run tauri dev` (or `npm run bridge` + `npx vite` and open http://localhost:1420/). On the welcome
screen press **Use this folder**, then **Add a practice board** and **Done**. On **Boards** open the practice
board: press and hold **Press** on TRIG1 and **Hold to test** on OUT1 to see the live tiles; **Plot** draws the
values that move. **Make it do something…** on the board page picks what starts it and what turns on (RLY1 for fog),
sends it to that board and says how to try it: hold **Press** on TRIG1. Or pick **Record effect** in that dialog: press **Start**, hold the buttons
("lamp (OUT1)", keys 1-8) and the practice board turns them on as you do; **Stop** and it does the whole take back;
**Keep it** saves it as an effect script and sends it; hold **Press** on TRIG1 and the board does it on its own. Go to **Your library**, **Start from an example** (pick "light up ghost"), save it, watch the blocks and
the "Looks good" line, type a mistake to see the board's own message, then **Try it on a practice board** and
press TRIG1 on the practice board shown below. Back on **Boards** the card says the effect is up to date; change
and save the effect and the card says a newer version is in your library, with a one-click update. On the board's
page, type in its effect script: **Send to this board only** and the badge says "changed on the board";
**Compare with Your library** shows both side by side; **Open in Your library** goes to the library's copy. Turn on
**Advanced** for the protocol console and the C++ preview. **Serial monitor** and **Help** (wiring guides) are
in the top bar.

## Updating the firmware submodule

```sh
git -C firmware fetch && git -C firmware checkout <commit on firmware-cpp>
./scripts/checker-parity.sh <commit>   # before moving: what the new golden set changes (SS-C5)
git add firmware && git commit -m "firmware: <what changed>"
./scripts/build-sim.sh
```

Studio's script checker is the board's own (the simulator). `core/tests/checker_parity.rs` runs every case of
the firmware's show-script golden set through Studio's `check_script` path, and `src/effects/parity.test.ts`
checks that the blocks, the C++ export and the hints read every golden script as the board does.

## Desktop builds

```sh
SPECTER_GUIDES_DIR=<firmware repo>/docs/wiring-guides/html scripts/build-desktop.sh deb   # or appimage, msi, dmg
```

The bundle carries the simulator (sidecar), the firmware's library, template and examples, and the wiring
guides (the build stops without them; `ALLOW_NO_GUIDES=1` builds anyway).
On a Mac, `scripts/build-macos.sh` builds `Specter Studio.app` and a `.dmg` (ad-hoc signed unless
`APPLE_SIGNING_IDENTITY` is set). Windows and macOS installers are also built by CI
(`.github/workflows/build.yml`); see `docs/BUILDING.md`.

## Layout

| | |
|---|---|
| `core/` | the device layer (Rust, no Tauri): `dispatch(command, args)` and an event stream; `src/bin/bridge.rs` serves it to a browser |
| `src-tauri/` | the thin Tauri shell: one `dispatch` command, events, the `plugin://` scheme |
| `src/` | the React + MUI app; `src/effects/` the editor (Monaco language, Blockly blocks, C++ preview) |
| `plugins/board-list/` | an example plugin and the plugin-side API (`studio-plugin.js`) |
| `firmware/` | the firmware repository (submodule): simulator, checker, library, template, examples |
| `tests/e2e/` | Playwright |

MIT licensed.

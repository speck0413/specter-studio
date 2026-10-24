"""A made-up board on a pseudo-terminal for the UI tests (tests/e2e/usb-board.spec.ts): it speaks the protocol's
JSON lines like a board plugged in with USB, takes board packages (get_board / set_board / reboot) and writes every
request's op to the file named by its first argument. Optional second and third arguments: its firmware type (default
generic, which takes board packages; another type has its board built in) and its name. Prints the terminal's path,
then answers until killed."""
import json
import os
import select
import sys
import tty

log = open(sys.argv[1], "a", buffering=1)
m, s = os.openpty()
tty.setraw(s)
print(os.ttyname(s), flush=True)

board = {"running": {"id": "proptroller", "name": "Proptroller board", "source": "built-in"}, "stored": None}
FW = sys.argv[2] if len(sys.argv) > 2 else "generic"
NAME = sys.argv[3] if len(sys.argv) > 3 else "USB lamp"
INFO = {"kind": "info", "name": NAME, "id": "0a1b2c3d4e5f" if FW == "generic" else "0a1b2c3d4e60", "fw": FW, "fw_version": "0.1.0",
        "fw_impl": "cpp", "fw_build": "test001", "mcu": "esp32-devkit", "capabilities": ["board_package"] if FW == "generic" else [],
        "update": {"install_max_s": 60}}


def answer(req):
    op = req.get("op")
    if op == "info":
        return dict(INFO, board=board["running"]["id"])
    if op == "state":
        return {"kind": "state", "uptime_ms": 1000, "inputs": [], "outputs": [], "shows": []}
    if op == "get_params":
        return {"kind": "params", "values": [{"key": "name", "value": NAME}, {"key": "wifi_ssid", "value": "Lab network"}]}
    if op == "get_backup":
        return {"kind": "backup", "data": {"format": "proptroller-backup", "format_version": 1, "name": NAME,
                                          "from": {"id": INFO["id"], "name": NAME, "fw": "generic", "fw_version": "0.1.0"},
                                          "settings": [], "shows": [], "script": None, "profile": None}}
    if op == "get_board" and FW == "generic":
        r = {"kind": "board", "mcu": "esp32-devkit", "running": board["running"], "presets": [
            {"id": "proptroller", "name": "Proptroller board"}, {"id": "lamp-two", "name": "Two lamps (example)"}]}
        if board["stored"]:
            r["stored"] = board["stored"]
        return r
    if op == "set_board" and FW == "generic":
        pick = req.get("preset") or (req.get("package") or {}).get("id")
        name = {"proptroller": "Proptroller board", "lamp-two": "Two lamps (example)"}.get(pick, (req.get("package") or {}).get("name", pick))
        board["stored"] = {"id": pick, "name": name, "pending": True}
        return {"kind": "board_set", "id": pick, "name": name, "restart_needed": True, "warnings": []}
    if op == "reboot":
        if board["stored"]:
            board["running"] = {"id": board["stored"]["id"], "name": board["stored"]["name"], "source": "stored"}
            board["stored"] = dict(board["stored"], pending=False)
        return {"kind": "done"}
    return None


line = b""
while True:
    r, _, _ = select.select([m], [], [], 0.2)
    if not r:
        continue
    try:
        data = os.read(m, 4096)
    except OSError:
        continue
    for c in data:
        if c in (10, 13):
            if line.startswith(b"{"):
                try:
                    req = json.loads(line)
                except ValueError:
                    req = {}
                log.write(str(req.get("op")) + "\n")
                res = answer(req)
                out = {"v": 1, "id": req.get("id"), "ok": True, "result": res} if res is not None else \
                      {"v": 1, "id": req.get("id"), "ok": False, "error": {"code": "unsupported", "message": "not on this test board"}}
                os.write(m, (json.dumps(out) + "\n").encode())
            line = b""
        else:
            line += bytes([c])

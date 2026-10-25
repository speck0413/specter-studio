//! The bundled simulator: the C++ firmware's own `sim` build (a whole board on this computer, speaking the
//! real protocol). Studio runs it for the emulator, the script checker and the tests.

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

pub struct Sim {
    child: Child,
    pub address: String,
    pub port: u16,
}

impl Drop for Sim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Where the simulator program is: `PROPTROLLER_SIM`, next to Studio's own executable (the bundled
/// sidecar), or the firmware submodule's build (development).
pub fn find_program() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PROPTROLLER_SIM") {
        return Some(PathBuf::from(p));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in ["proptroller-sim", "proptroller-sim.exe"] {
                let p = dir.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../firmware/firmware/arduino/.pio/build/sim/program");
    dev.exists().then_some(dev)
}

#[derive(Default, Clone)]
pub struct SimOptions {
    pub name: Option<String>,
    pub id: Option<String>,
    pub speed: Option<f64>,
    pub discovery_port: u16, // 0 = no UDP discovery
    pub fail_self_check: bool,
    pub swap_ms: Option<u64>,
    /// a fixed port (switching a practice board back on keeps its address); None = any free port
    pub port: Option<u16>,
    /// where the board link's peer-to-peer frames go (`host:port,...`, the other boards' discovery ports) instead of a
    /// broadcast: two practice boards on this computer tell each other (PROTOCOL.md "Board link"; needs a
    /// discovery port of its own on each)
    pub link_peers: Option<String>,
}

/// Starts a simulated board on a free port and waits for its "on http://localhost:PORT/" line.
pub fn start(o: &SimOptions) -> Result<Sim, String> {
    let prog = find_program().ok_or("the simulator is not built: run scripts/build-sim.sh")?;
    let mut cmd = Command::new(prog);
    cmd.args(["--port", &o.port.unwrap_or(0).to_string(), "--discovery-port", &o.discovery_port.to_string()]);
    if let Some(n) = &o.name {
        cmd.args(["--name", n]);
    }
    if let Some(i) = &o.id {
        cmd.args(["--id", i]);
    }
    if let Some(s) = o.speed {
        cmd.args(["--speed", &s.to_string()]);
    }
    if let Some(s) = o.swap_ms {
        cmd.args(["--swap-ms", &s.to_string()]);
    }
    if o.fail_self_check {
        cmd.arg("--fail-self-check");
    }
    if let Some(p) = &o.link_peers {
        cmd.args(["--link-peers", p]);
    }
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| format!("cannot start the simulator: {e}"))?;
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    let _ = out.read_line(&mut line);
    let port = line
        .split("localhost:")
        .nth(1)
        .and_then(|r| r.split('/').next())
        .and_then(|p| p.parse::<u16>().ok());
    let Some(port) = port else {
        let _ = child.kill();
        return Err(format!("the simulator did not start: {}", line.trim()));
    };
    // keep draining its output so it never blocks on a full pipe
    std::thread::spawn(move || for _ in out.lines() {});
    Ok(Sim { child, address: format!("http://127.0.0.1:{port}"), port })
}

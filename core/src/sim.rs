//! The bundled simulator: the C++ firmware's own `sim` build (a whole board on this computer, speaking the
//! real protocol). Studio runs it for the emulator, the script checker and the tests.

use std::collections::HashSet;
use std::io::{BufRead, BufReader};
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

pub struct Sim {
    child: Child,
    pub address: String,
    pub port: u16,
    /// this board's place in the practice boards' link relay, given back when it stops
    _relay: Option<RelaySeat>,
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
    /// join the practice boards' link relay ([`relay`]): this board's tell lines reach every other practice board
    /// on this computer, and theirs reach it (needs a `discovery_port` of its own; `link_peers` wins when given)
    pub link_relay: bool,
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
    let mut seat = None;
    if let Some(p) = &o.link_peers {
        cmd.args(["--link-peers", p]);
    } else if o.link_relay && o.discovery_port != 0 {
        let r = relay()?;
        cmd.args(["--link-peers", &format!("127.0.0.1:{}", r.port)]);
        seat = Some(r.seat(o.discovery_port));
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
    Ok(Sim { child, address: format!("http://127.0.0.1:{port}"), port, _relay: seat })
}

// ---------------------------------------------------------------- the practice boards' board link

/// The board link between practice boards (PROTOCOL.md "Board link", peer to peer). A simulator sends its frames
/// only to the addresses it was started with (`--link-peers`), and practice boards come and go, so every practice
/// board sends to one relay on this computer instead. The relay repeats each frame from a practice board's UDP port
/// to every other practice board's port, as a broadcast on a Wi-Fi network would; a board answers the relay (the
/// frame's source), and the answer is repeated the same way, so the board that asked gets it. Only frames of the
/// board link (`PTL1`) from a practice board's own port are repeated; real boards never see the relay.
pub struct Relay {
    pub port: u16,
    seats: Arc<Mutex<HashSet<u16>>>,
}

/// A practice board's port in the relay, for as long as the board runs.
pub struct RelaySeat {
    port: u16,
    seats: Arc<Mutex<HashSet<u16>>>,
}

impl Drop for RelaySeat {
    fn drop(&mut self) {
        self.seats.lock().unwrap().remove(&self.port);
    }
}

impl Relay {
    pub fn seat(&self, port: u16) -> RelaySeat {
        self.seats.lock().unwrap().insert(port);
        RelaySeat { port, seats: self.seats.clone() }
    }
    /// The practice boards' ports now in the relay.
    pub fn ports(&self) -> Vec<u16> {
        let mut v: Vec<u16> = self.seats.lock().unwrap().iter().copied().collect();
        v.sort();
        v
    }
}

/// The relay (started the first time a practice board needs it, then kept while Studio runs).
pub fn relay() -> Result<&'static Relay, String> {
    static RELAY: OnceLock<Result<Relay, String>> = OnceLock::new();
    RELAY
        .get_or_init(|| {
            let sock = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).map_err(|e| format!("cannot open the practice boards' link: {e}"))?;
            let port = sock.local_addr().map_err(|e| e.to_string())?.port();
            let seats: Arc<Mutex<HashSet<u16>>> = Default::default();
            let s2 = seats.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 512];
                loop {
                    let Ok((n, from)) = sock.recv_from(&mut buf) else { continue };
                    if !from.ip().is_loopback() || n < 4 || &buf[..4] != b"PTL1" {
                        continue;
                    }
                    let to: Vec<u16> = {
                        let seats = s2.lock().unwrap();
                        if !seats.contains(&from.port()) {
                            continue;
                        }
                        seats.iter().copied().filter(|p| *p != from.port()).collect()
                    };
                    for p in to {
                        let _ = sock.send_to(&buf[..n], SocketAddrV4::new(Ipv4Addr::LOCALHOST, p));
                    }
                }
            });
            Ok(Relay { port, seats })
        })
        .as_ref()
        .map_err(|e| e.clone())
}

/// A free UDP port on this computer, for a practice board's discovery and board link socket.
pub fn free_udp_port() -> Result<u16, String> {
    let s = UdpSocket::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).map_err(|e| format!("no free UDP port: {e}"))?;
    Ok(s.local_addr().map_err(|e| e.to_string())?.port())
}

/// A practice board's id from its name (the same name, the same id: its backups and Studio's notes about it stay
/// its own), so two practice boards with different names never share one; the board link drops frames carrying
/// the board's own id. Unnamed boards get a number of their own.
pub fn practice_id(name: Option<&str>) -> String {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let h = match name {
        Some(n) => n.bytes().fold(0x811c9dc5u32, |h, b| (h ^ b as u32).wrapping_mul(0x01000193)),
        None => 0x5eed_0000 | NEXT.fetch_add(1, Ordering::Relaxed),
    };
    format!("sim{h:08x}")
}

//! The shared read-only page: a view password is slow to guess (each wrong one in a row waits longer).
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn get(port: u16, auth: Option<&str>) -> String {
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let a = auth.map(|x| format!("Authorization: Basic {x}\r\n")).unwrap_or_default();
    s.write_all(format!("GET / HTTP/1.1\r\nHost: x\r\n{a}\r\n").as_bytes()).await.unwrap();
    let mut out = vec![0u8; 64];
    let n = s.read(&mut out).await.unwrap_or(0);
    String::from_utf8_lossy(&out[..n]).to_string()
}

#[tokio::test]
async fn wrong_view_passwords_wait_longer_and_longer() {
    let v = studio_core::viewer::Viewer::start(0, Some("boo".into())).await.unwrap();
    // "x:nope" and "x:boo" in base64
    let (bad, good) = ("eDpub3Bl", "eDpib28=");
    assert!(get(v.port, None).await.contains("401"), "no password: asked for one, at once");
    let t = Instant::now();
    assert!(get(v.port, Some(bad)).await.contains("401"));
    assert!(get(v.port, Some(bad)).await.contains("401"));
    assert!(t.elapsed() >= Duration::from_millis(2900), "1 s, then 2 s: {:?}", t.elapsed());
    let t = Instant::now();
    assert!(get(v.port, Some(good)).await.contains("200"));
    assert!(t.elapsed() < Duration::from_millis(900), "the right password answers at once");
}

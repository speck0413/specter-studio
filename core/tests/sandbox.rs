//! S12: what the UI's commands can reach on this computer, whatever it asks for.

use serde_json::json;
use studio_core::Studio;

#[tokio::test]
async fn files_stay_in_the_library_folder_and_secrets_stay_in_the_core() {
    let base = std::env::temp_dir().join(format!("specter-sandbox-{}", std::process::id()));
    let (a, b) = (base.join("A"), base.join("B"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let s = Studio::new();
    s.dispatch("workspace_set", json!({ "folder": a })).await.unwrap();
    s.dispatch("file_write", json!({ "folder": a, "path": a.join("x.ino"), "text": "ok" })).await.unwrap();
    assert_eq!(s.dispatch("file_read", json!({ "folder": a, "path": a.join("x.ino") })).await.unwrap(), "ok");
    // naming another folder as the "library" does not move the fence
    let e = s.dispatch("file_write", json!({ "folder": b, "path": b.join("y.txt"), "text": "pwned" })).await.unwrap_err();
    assert!(e.contains("only in your library folder"), "{e}");
    assert!(!b.join("y.txt").exists());
    assert!(s.dispatch("file_write", json!({ "folder": a, "path": b.join("y.txt"), "text": "pwned" })).await.is_err());
    // the person chose another library folder: from then on that one
    s.dispatch("library_list", json!({ "folder": b })).await.unwrap();
    s.dispatch("file_write", json!({ "folder": b, "path": b.join("y.txt"), "text": "ok" })).await.unwrap();
    assert!(s.dispatch("file_read", json!({ "folder": a, "path": a.join("x.ino") })).await.is_err());
    // only page passwords come back from the keychain; commands the UI never sends are not there
    for name in ["bridge-password", "viewer-password"] {
        assert!(s.dispatch("secret_get", json!({ "name": name })).await.unwrap_err().contains("used by Studio itself"));
    }
    for cmd in ["flash", "flash_plan", "mqtt_rpc", "firmware_build", "probe", "secret_delete"] {
        assert_eq!(s.dispatch(cmd, json!({})).await.unwrap_err(), format!("unknown command {cmd}"));
    }
    // a link inside the folder that points outside it is not followed (N2)
    #[cfg(unix)]
    {
        std::fs::write(base.join("secret.txt"), "outside").unwrap();
        std::os::unix::fs::symlink(base.join("secret.txt"), b.join("link.txt")).unwrap();
        assert!(s.dispatch("file_read", json!({ "folder": b, "path": b.join("link.txt") })).await.unwrap_err().contains("link"));
        assert!(s.dispatch("file_write", json!({ "folder": b, "path": b.join("link.txt"), "text": "x" })).await.is_err());
        assert_eq!(std::fs::read_to_string(base.join("secret.txt")).unwrap(), "outside");
    }
    let _ = std::fs::remove_dir_all(base);
}

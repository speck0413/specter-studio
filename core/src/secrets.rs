//! Set-only secrets (the MQTT upstream password, secret header values of web-request rules): the system
//! keychain in the app, memory in tests. A secret goes in and is used by the core; it never comes back out to
//! the UI, a log, an export or a settings backup (only "set" / "not set").

use std::collections::HashMap;
use std::sync::Mutex;

/// The keychain service every Studio secret lives under.
pub const SERVICE: &str = "specter-studio";

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Option<String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str);
}

/// The system keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux).
pub struct Keychain;

impl SecretStore for Keychain {
    fn get(&self, name: &str) -> Option<String> {
        keyring::Entry::new(SERVICE, name).ok()?.get_password().ok().filter(|p| !p.is_empty())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        let e = keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())?;
        e.set_password(value).map_err(|e| format!("the keychain refused: {e}"))
    }
    fn delete(&self, name: &str) {
        if let Ok(e) = keyring::Entry::new(SERVICE, name) {
            let _ = e.delete_credential();
        }
    }
}

/// Secrets kept in memory only (tests, and a computer without a keychain).
#[derive(Default)]
pub struct Memory(Mutex<HashMap<String, String>>);

impl SecretStore for Memory {
    fn get(&self, name: &str) -> Option<String> {
        self.0.lock().unwrap().get(name).cloned().filter(|p| !p.is_empty())
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().insert(name.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, name: &str) {
        self.0.lock().unwrap().remove(name);
    }
}

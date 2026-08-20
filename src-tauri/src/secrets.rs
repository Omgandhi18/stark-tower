//! Secret storage kept OUT of config.json. Engine `api-key-env` values live here
//! in a 0600 `secrets.json` (engine id → var → value) and are never returned over
//! IPC — the config the renderer sees carries only a [`SENTINEL`] marker where a
//! secret is set. This keeps real keys off the IPC boundary and out of the
//! config's corrupt-backups. (A future step could move these into the OS keychain.)

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Placeholder the config stores (and the UI shows, masked) where a real secret
/// exists. Kept out of band from any plausible real key.
pub const SENTINEL: &str = "__stark_secret_set__";

/// engine id → (env var → secret value).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SecretStore {
    #[serde(flatten)]
    pub engines: BTreeMap<String, BTreeMap<String, String>>,
}

impl SecretStore {
    pub fn get(&self, engine: &str, var: &str) -> Option<&String> {
        self.engines.get(engine).and_then(|m| m.get(var))
    }
    pub fn set(&mut self, engine: &str, var: &str, value: &str) {
        self.engines
            .entry(engine.to_string())
            .or_default()
            .insert(var.to_string(), value.to_string());
    }
    pub fn remove(&mut self, engine: &str, var: &str) {
        if let Some(m) = self.engines.get_mut(engine) {
            m.remove(var);
            if m.is_empty() {
                self.engines.remove(engine);
            }
        }
    }
    pub fn has(&self, engine: &str, var: &str) -> bool {
        self.get(engine, var).is_some()
    }
}

/// Move any plaintext secret in an engine's `auth.env` into the store and leave
/// a [`SENTINEL`] marker in its place. Idempotent, and it interprets the UI
/// round-trip: a var already equal to SENTINEL keeps its stored secret, a new
/// value replaces it, and an empty value clears it. Used both to migrate an
/// existing config and to reconcile an engine the UI just saved.
pub fn reconcile(store: &mut SecretStore, engine: &mut crate::config::EngineConfig) {
    let eid = engine.id.clone();
    let incoming = std::mem::take(&mut engine.auth.env);
    let mut kept = BTreeMap::new();
    for (var, val) in incoming {
        if val == SENTINEL {
            if store.has(&eid, &var) {
                kept.insert(var, SENTINEL.to_string()); // unchanged — keep the secret
            }
        } else if !val.trim().is_empty() {
            store.set(&eid, &var, &val); // new / changed secret
            kept.insert(var, SENTINEL.to_string());
        } else {
            store.remove(&eid, &var); // cleared
        }
    }
    engine.auth.env = kept;
}

/// Replace an engine's SENTINEL `auth.env` values with the real secrets before
/// spawning. A var with no stored secret becomes empty (so it isn't injected).
pub fn hydrate(store: &SecretStore, engine: &mut crate::config::EngineConfig) {
    let eid = engine.id.clone();
    for (var, val) in engine.auth.env.iter_mut() {
        if val == SENTINEL {
            *val = store.get(&eid, var).cloned().unwrap_or_default();
        }
    }
}

pub fn load(path: &Path) -> SecretStore {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Atomic write, owner-only (0600).
pub fn save(path: &Path, store: &SecretStore) {
    if let Ok(out) = serde_json::to_string_pretty(store) {
        let tmp = path.with_extension("json.starktmp");
        if std::fs::write(&tmp, out).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
            }
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_get_remove_roundtrip() {
        let mut s = SecretStore::default();
        assert!(!s.has("claude-code", "ANTHROPIC_API_KEY"));
        s.set("claude-code", "ANTHROPIC_API_KEY", "sk-abc");
        assert_eq!(s.get("claude-code", "ANTHROPIC_API_KEY").unwrap(), "sk-abc");
        assert!(s.has("claude-code", "ANTHROPIC_API_KEY"));
        s.remove("claude-code", "ANTHROPIC_API_KEY");
        assert!(!s.has("claude-code", "ANTHROPIC_API_KEY"));
        assert!(s.engines.is_empty()); // empty engine map pruned
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = std::env::temp_dir().join(format!("stark-sec-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.json");
        let mut s = SecretStore::default();
        s.set("codex", "OPENAI_API_KEY", "sk-xyz");
        save(&path, &s);
        let loaded = load(&path);
        assert_eq!(loaded.get("codex", "OPENAI_API_KEY").unwrap(), "sk-xyz");
        std::fs::remove_dir_all(&dir).ok();
    }
}

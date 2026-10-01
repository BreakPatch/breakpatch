//! Result addresses for suites in a tests folder (Solo, the Team repo's issue #36): where a
//! scheduled suite's result message goes (a Slack or Teams webhook, or a web address). Anyone
//! with the address can post, so it's a secret: it lives in the Keychain, service
//! `dev.breakpatch.results`, one entry per suite (`<connection id>/<suite id>`), and never in the
//! folder, which may be shared through Git. A Team workspace keeps its addresses in the workspace
//! instead (the Team module's data/firebase/notifyStore.ts).

use crate::licence::valid_ws_key;
use crate::secrets::SecretStore;

pub const SERVICE: &str = "dev.breakpatch.results";
const MAX_URL: usize = 2048;

pub struct ResultAddresses<S: SecretStore> {
    store: S,
}

/// A suite id as the tests folder names its files: a short slug.
fn valid_suite_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 120 && id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

fn entry(ws_key: &str, suite_id: &str) -> Result<String, String> {
    if !valid_ws_key(ws_key) || (ws_key.contains('/') && !ws_key.starts_with("team:")) {
        return Err("That isn't a connection key.".into());
    }
    if !valid_suite_id(suite_id) {
        return Err("That isn't a suite id.".into());
    }
    Ok(format!("{ws_key}/{suite_id}"))
}

/// A full https address with no spaces, short enough for a webhook.
fn valid_url(url: &str) -> bool {
    url.len() <= MAX_URL
        && url.strip_prefix("https://").is_some_and(|rest| !rest.is_empty())
        && !url.chars().any(|c| c.is_whitespace() || c.is_control())
}

impl<S: SecretStore> ResultAddresses<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn get(&self, ws_key: &str, suite_id: &str) -> Result<Option<String>, String> {
        self.store.get(&entry(ws_key, suite_id)?)
    }

    /// Saves the address (None or "": forgets it).
    pub fn set(&self, ws_key: &str, suite_id: &str, url: Option<&str>) -> Result<(), String> {
        let name = entry(ws_key, suite_id)?;
        match url.map(str::trim).filter(|u| !u.is_empty()) {
            None => self.store.delete(&name),
            Some(u) if valid_url(u) => self.store.set(&name, u),
            Some(_) => Err("Use a full web address, starting with https://".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[derive(Default, Clone)]
    struct Mem(Arc<Mutex<HashMap<String, String>>>);
    impl SecretStore for Mem {
        fn get(&self, n: &str) -> Result<Option<String>, String> {
            Ok(self.0.lock().unwrap().get(n).cloned())
        }
        fn set(&self, n: &str, v: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(n.into(), v.into());
            Ok(())
        }
        fn delete(&self, n: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(n);
            Ok(())
        }
    }

    #[test]
    fn an_address_is_kept_per_folder_and_suite() {
        let m = Mem::default();
        let r = ResultAddresses::new(m.clone());
        r.set("local:0123abcd", "smoke", Some("https://hooks.slack.com/services/T/B/x")).unwrap();
        assert_eq!(r.get("local:0123abcd", "smoke").unwrap().as_deref(), Some("https://hooks.slack.com/services/T/B/x"));
        assert!(m.0.lock().unwrap().contains_key("local:0123abcd/smoke"));
        assert_eq!(r.get("local:0123abcd", "nightly").unwrap(), None);
        assert_eq!(r.get("local:ffff0000", "smoke").unwrap(), None);
        r.set("local:0123abcd", "smoke", None).unwrap();
        assert_eq!(r.get("local:0123abcd", "smoke").unwrap(), None);
    }

    #[test]
    fn only_https_addresses_and_real_keys_are_taken() {
        let r = ResultAddresses::new(Mem::default());
        assert!(r.set("local:0123abcd", "smoke", Some("http://example.com")).is_err());
        assert!(r.set("local:0123abcd", "smoke", Some("https://a b")).is_err());
        assert!(r.set("local:0123abcd", "smoke", Some("https://")).is_err());
        assert!(r.set("local:0123abcd", "../x", Some("https://example.com")).is_err());
        assert!(r.set("bad key", "smoke", Some("https://example.com")).is_err());
        assert!(r.set("local:a/b", "smoke", Some("https://example.com")).is_err());
        assert!(r.set("local:0123abcd", "smoke", Some("")).is_ok());
    }
}

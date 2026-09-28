//! Saved secrets (spec §13): values in the macOS Keychain, service `dev.breakpatch.secrets`,
//! one entry per name. The Keychain can't list entries for us, so the names live in a small
//! JSON index in the app data dir, each with its policy: the sites it may be typed on and whether
//! the local runner may use it (security review A1). The index never holds a value.
//!
//! The shell hands the engine each secret with its policy (`attach_policies`, called by
//! `engine_request`), so the sites come from here, never from the UI or a test file.

use std::collections::BTreeMap;
use std::fs;
#[cfg(test)]
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const SERVICE: &str = "dev.breakpatch.secrets";

pub trait SecretStore: Send + Sync {
    fn get(&self, name: &str) -> Result<Option<String>, String>;
    fn set(&self, name: &str, value: &str) -> Result<(), String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// The OS credential store through the `keyring` crate, one Keychain service per store
/// (saved secrets: `dev.breakpatch.secrets`; the licence: `dev.breakpatch.licence`).
pub struct KeyringStore {
    service: &'static str,
}

impl KeyringStore {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }
    fn entry(&self, name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.service, name).map_err(|e| e.to_string())
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new(SERVICE)
    }
}

impl SecretStore for KeyringStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.entry(name)?.set_password(value).map_err(|e| e.to_string())
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// What each saved secret may do, kept next to its name in the index (never its value).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    /// The sites it may be typed on (or sent to in a call's header): `https://app.example.com`.
    /// Empty for secrets saved before sites existed: the engine then types them nowhere, and the
    /// app asks once to allow the test app's site.
    #[serde(default)]
    pub origins: Vec<String>,
    /// Whether Breakpatch Team's local runner may use it. Off unless someone turns it on.
    #[serde(default)]
    pub runner_can_use: bool,
}

/// One saved secret as the UI sees it: the name and its policy, never the value.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    pub origins: Vec<String>,
    pub runner_can_use: bool,
}

/// The index file: `{"version": 2, "secrets": {"NAME": {"origins": [...], "runnerCanUse": false}}}`.
/// Version 1 was a sorted JSON array of names; it's read as names with no sites.
#[derive(Serialize, Deserialize)]
struct IndexFile {
    version: u32,
    secrets: BTreeMap<String, Policy>,
}

pub struct SecretsIndex {
    path: PathBuf,
}

impl SecretsIndex {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Name → policy, sorted by name.
    pub fn load(&self) -> BTreeMap<String, Policy> {
        let Ok(text) = fs::read_to_string(&self.path) else { return BTreeMap::new() };
        if let Ok(names) = serde_json::from_str::<Vec<String>>(&text) {
            return names.into_iter().map(|n| (n, Policy::default())).collect();
        }
        match serde_json::from_str::<IndexFile>(&text) {
            Ok(f) => f.secrets,
            Err(e) => {
                log::warn!("secrets index at {} is unreadable, starting empty: {e}", self.path.display());
                BTreeMap::new()
            }
        }
    }

    pub fn names(&self) -> Vec<String> {
        self.load().into_keys().collect()
    }

    fn save(&self, secrets: &BTreeMap<String, Policy>) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let file = IndexFile { version: 2, secrets: secrets.clone() };
        let text = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    /// Adds the name (keeping its policy if it's there), or sets its policy when one is given.
    pub fn put(&self, name: &str, policy: Option<Policy>) -> Result<(), String> {
        let mut all = self.load();
        let before = all.get(name).cloned();
        let next = policy.or_else(|| before.clone()).unwrap_or_default();
        if before.as_ref() != Some(&next) {
            all.insert(name.to_string(), next);
            self.save(&all)?;
        }
        Ok(())
    }

    pub fn remove(&self, name: &str) -> Result<(), String> {
        let mut all = self.load();
        if all.remove(name).is_some() {
            self.save(&all)?;
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// Names are reference names like `ACME_TEST_EMAIL`: letters, digits, `_`, `-`, `.`.
pub fn validate_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Give the secret a name.".into());
    }
    if n.len() > 128 {
        return Err("Secret names can be up to 128 characters.".into());
    }
    if !n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')) {
        return Err("Use letters, numbers and underscores in secret names.".into());
    }
    Ok(n)
}

/// Most sites one secret can be allowed on.
pub const MAX_ORIGINS: usize = 20;

/// A site as the engine compares it: `scheme://host[:port]`, lower case, default port left out.
/// Takes a whole address too (`https://app.example.com/login` → `https://app.example.com`).
pub fn normalize_origin(text: &str) -> Result<String, String> {
    let bad = || format!("{} isn't a web address. Use one like https://app.example.com.", text.trim());
    let u = url::Url::parse(text.trim()).map_err(|_| bad())?;
    if !matches!(u.scheme(), "https" | "http") {
        return Err(bad());
    }
    let host = match u.host() {
        Some(url::Host::Domain(d)) => d.trim_end_matches('.').to_ascii_lowercase(),
        Some(url::Host::Ipv4(ip)) => ip.to_string(),
        Some(url::Host::Ipv6(ip)) => format!("[{ip}]"),
        None => return Err(bad()),
    };
    if host.is_empty() {
        return Err(bad());
    }
    Ok(match u.port() {
        Some(p) => format!("{}://{host}:{p}", u.scheme()),
        None => format!("{}://{host}", u.scheme()),
    })
}

/// Normalised, de-duplicated sites, in the order given.
pub fn normalize_origins(list: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for o in list.iter().filter(|o| !o.trim().is_empty()) {
        let n = normalize_origin(o)?;
        if !out.contains(&n) {
            out.push(n);
        }
    }
    if out.len() > MAX_ORIGINS {
        return Err(format!("A secret can be allowed on up to {MAX_ORIGINS} sites."));
    }
    Ok(out)
}

/// Engine methods whose params carry saved secrets (engine/PROTOCOL.md "Saved secrets").
pub fn carries_secrets(method: &str) -> bool {
    matches!(method, "run.start" | "record.point" | "call.try")
}

/// Gives every secret in `params.secrets` the sites and runner flag from the index, replacing
/// whatever the caller sent: `{NAME: value}` or `{NAME: {value, ...}}` becomes
/// `{NAME: {value, origins, runnerCanUse}}`. A name the index doesn't know gets no sites, so the
/// engine types it nowhere. Entries without a value are dropped.
pub fn attach_policies(params: &mut Value, index: &BTreeMap<String, Policy>) {
    let Some(secrets) = params.get_mut("secrets").and_then(Value::as_object_mut) else { return };
    let taken = std::mem::take(secrets);
    for (name, v) in taken {
        let value = match v {
            Value::String(s) => s,
            Value::Object(ref o) => match o.get("value") {
                Some(Value::String(s)) => s.clone(),
                _ => continue,
            },
            _ => continue,
        };
        let policy = index.get(&name).cloned().unwrap_or_default();
        secrets
            .insert(name, json!({ "value": value, "origins": policy.origins, "runnerCanUse": policy.runner_can_use }));
    }
}

pub struct Secrets<S: SecretStore> {
    store: S,
    index: SecretsIndex,
    lock: Mutex<()>,
}

impl<S: SecretStore> Secrets<S> {
    pub fn new(store: S, index: SecretsIndex) -> Self {
        Self { store, index, lock: Mutex::new(()) }
    }

    pub fn list(&self) -> Vec<String> {
        let _g = self.lock.lock().unwrap();
        self.index.names()
    }

    /// Names with their sites and runner flag (no values).
    pub fn info(&self) -> Vec<SecretInfo> {
        let _g = self.lock.lock().unwrap();
        self.index
            .load()
            .into_iter()
            .map(|(name, p)| SecretInfo { name, origins: p.origins, runner_can_use: p.runner_can_use })
            .collect()
    }

    /// Name → policy, for `attach_policies`.
    pub fn policies(&self) -> BTreeMap<String, Policy> {
        let _g = self.lock.lock().unwrap();
        self.index.load()
    }

    /// Saves the value. `origins` / `runner_can_use` set the policy; left out, it stays as it was
    /// (a new secret: no sites, runner off).
    pub fn set(
        &self,
        name: &str,
        value: &str,
        origins: Option<Vec<String>>,
        runner_can_use: Option<bool>,
    ) -> Result<(), String> {
        let name = validate_name(name)?;
        let origins = origins.map(|o| normalize_origins(&o)).transpose()?;
        let _g = self.lock.lock().unwrap();
        let before = self.index.load().get(name).cloned().unwrap_or_default();
        let policy = Policy {
            origins: origins.unwrap_or(before.origins),
            runner_can_use: runner_can_use.unwrap_or(before.runner_can_use),
        };
        self.store.set(name, value)?;
        self.index.put(name, Some(policy))
    }

    /// Changes where a saved secret may be used, without touching its value (no Keychain access).
    pub fn set_policy(&self, name: &str, origins: Vec<String>, runner_can_use: bool) -> Result<(), String> {
        let name = validate_name(name)?;
        let origins = normalize_origins(&origins)?;
        let _g = self.lock.lock().unwrap();
        if !self.index.load().contains_key(name) {
            return Err(format!("There's no saved secret {name} on this Mac."));
        }
        self.index.put(name, Some(Policy { origins, runner_can_use }))
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        let name = name.trim();
        let _g = self.lock.lock().unwrap();
        self.store.delete(name)?;
        self.index.remove(name)
    }

    /// Values for the names that exist; missing names are simply left out (the UI reports them).
    pub fn resolve(&self, names: &[String]) -> Result<BTreeMap<String, String>, String> {
        let _g = self.lock.lock().unwrap();
        let mut out = BTreeMap::new();
        for name in names {
            let name = name.trim();
            if name.is_empty() || out.contains_key(name) {
                continue;
            }
            if let Some(v) = self.store.get(name)? {
                out.insert(name.to_string(), v);
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemStore(Mutex<HashMap<String, String>>);
    impl SecretStore for MemStore {
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

    fn fixture() -> (tempfile::TempDir, Secrets<MemStore>) {
        let dir = tempfile::tempdir().unwrap();
        let index = SecretsIndex::new(dir.path().join("nested").join("secrets-index.json"));
        (dir, Secrets::new(MemStore::default(), index))
    }

    fn set(s: &Secrets<MemStore>, n: &str, v: &str) {
        s.set(n, v, None, None).unwrap();
    }

    #[test]
    fn set_list_delete_keeps_index_sorted_and_unique() {
        let (_d, s) = fixture();
        assert!(s.list().is_empty());
        set(&s, "ACME_TEST_PASSWORD", "pw");
        set(&s, "ACME_TEST_EMAIL", "qa@x.com");
        set(&s, "ACME_TEST_EMAIL", "qa2@x.com");
        assert_eq!(s.list(), vec!["ACME_TEST_EMAIL", "ACME_TEST_PASSWORD"]);
        s.delete("ACME_TEST_EMAIL").unwrap();
        s.delete("NOT_THERE").unwrap();
        assert_eq!(s.list(), vec!["ACME_TEST_PASSWORD"]);
    }

    #[test]
    fn index_file_holds_names_and_sites_only() {
        let (_d, s) = fixture();
        s.set("TOKEN", "super-secret-value", Some(vec!["https://App.Example.com/login".into()]), Some(true)).unwrap();
        let text = fs::read_to_string(s.index.path()).unwrap();
        assert!(text.contains("TOKEN") && text.contains("https://app.example.com") && text.contains("runnerCanUse"));
        assert!(!text.contains("super-secret-value"));
    }

    #[test]
    fn resolve_returns_only_present_names() {
        let (_d, s) = fixture();
        set(&s, "A", "1");
        set(&s, "B", "2");
        let got = s.resolve(&["A".into(), "MISSING".into(), "B".into(), "A".into(), " ".into()]).unwrap();
        assert_eq!(got, BTreeMap::from([("A".to_string(), "1".to_string()), ("B".to_string(), "2".to_string())]));
    }

    #[test]
    fn corrupt_or_missing_index_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets-index.json");
        let index = SecretsIndex::new(path.clone());
        assert!(index.load().is_empty());
        fs::write(&path, "{not json").unwrap();
        assert!(index.load().is_empty());
        index.put("X", None).unwrap();
        assert_eq!(index.names(), vec!["X"]);
    }

    #[test]
    fn names_are_validated() {
        assert_eq!(validate_name("  ACME_TEST_EMAIL "), Ok("ACME_TEST_EMAIL"));
        assert!(validate_name("").is_err());
        assert!(validate_name("has space").is_err());
        assert!(validate_name(&"A".repeat(129)).is_err());
        let (_d, s) = fixture();
        assert!(s.set("bad name", "v", None, None).is_err());
        assert!(s.list().is_empty());
    }

    // ---- Sites and the runner flag (security review A1) ----

    #[test]
    fn an_old_index_of_names_reads_as_secrets_with_no_sites() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets-index.json");
        fs::write(&path, r#"["ACME_TEST_EMAIL", "PROD_DB_PASSWORD"]"#).unwrap();
        let s = Secrets::new(MemStore::default(), SecretsIndex::new(path.clone()));
        assert_eq!(s.list(), vec!["ACME_TEST_EMAIL", "PROD_DB_PASSWORD"]);
        assert_eq!(s.info()[1], SecretInfo { name: "PROD_DB_PASSWORD".into(), origins: vec![], runner_can_use: false });
        // Allowing a site writes the new format; the names are all kept.
        s.set_policy("PROD_DB_PASSWORD", vec!["https://db.acme.com".into()], false).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"version\": 2") && text.contains("ACME_TEST_EMAIL"));
        assert_eq!(s.info()[1].origins, vec!["https://db.acme.com"]);
    }

    #[test]
    fn changing_the_value_keeps_the_sites_and_the_policy_can_change_alone() {
        let (_d, s) = fixture();
        s.set("PW", "one", Some(vec!["https://app.acme.com".into()]), None).unwrap();
        set(&s, "PW", "two");
        assert_eq!(s.info()[0].origins, vec!["https://app.acme.com"]);
        assert!(!s.info()[0].runner_can_use, "the runner flag is off by default");
        s.set_policy("PW", vec!["https://a.acme.com".into(), "https://a.acme.com/x".into()], true).unwrap();
        assert_eq!(
            s.info()[0],
            SecretInfo { name: "PW".into(), origins: vec!["https://a.acme.com".into()], runner_can_use: true }
        );
        assert_eq!(s.resolve(&["PW".into()]).unwrap()["PW"], "two");
        assert!(s.set_policy("NOT_THERE", vec![], false).is_err());
        assert!(s.set_policy("PW", vec!["file:///etc".into()], false).is_err());
    }

    #[test]
    fn sites_are_normalised_like_the_engine_does() {
        assert_eq!(normalize_origin("https://App.Example.com/login?x=1").unwrap(), "https://app.example.com");
        assert_eq!(normalize_origin("https://app.example.com:443").unwrap(), "https://app.example.com");
        assert_eq!(normalize_origin("http://127.0.0.1:8080/").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(normalize_origin(" http://localhost ").unwrap(), "http://localhost");
        assert_eq!(normalize_origin("https://[::1]:8443/").unwrap(), "https://[::1]:8443");
        assert_eq!(normalize_origin("https://example.com./").unwrap(), "https://example.com");
        for bad in ["app.example.com", "file:///etc/passwd", "data:text/html,x", "ftp://x.com", "", "https://"] {
            assert!(normalize_origin(bad).is_err(), "{bad}");
        }
        let many: Vec<String> = (0..=MAX_ORIGINS).map(|i| format!("https://s{i}.example.com")).collect();
        assert!(normalize_origins(&many).is_err());
    }

    #[test]
    fn the_engine_gets_each_secret_with_the_sites_from_the_index() {
        let index = BTreeMap::from([
            ("PW".to_string(), Policy { origins: vec!["https://app.acme.com".into()], runner_can_use: true }),
            ("OLD".to_string(), Policy::default()),
        ]);
        let mut p = json!({ "runId": "r", "secrets": {
            "PW": "hunter2",
            "OLD": { "value": "x", "origins": ["https://evil.example"], "runnerCanUse": true },
            "UNKNOWN": "y",
            "BROKEN": 7,
        }});
        attach_policies(&mut p, &index);
        assert_eq!(
            p["secrets"],
            json!({
                "PW": { "value": "hunter2", "origins": ["https://app.acme.com"], "runnerCanUse": true },
                "OLD": { "value": "x", "origins": [], "runnerCanUse": false },
                "UNKNOWN": { "value": "y", "origins": [], "runnerCanUse": false },
            })
        );
        let mut none = json!({ "runId": "r" });
        attach_policies(&mut none, &index);
        assert_eq!(none, json!({ "runId": "r" }));
        assert!(carries_secrets("run.start") && carries_secrets("record.point") && carries_secrets("call.try"));
        assert!(!carries_secrets("browser.open"));
    }
}

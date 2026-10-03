//! Saved secrets (spec §13): values in the OS credential store, service `dev.breakpatch.secrets`,
//! one entry per name: the Keychain on macOS, the Secret Service (GNOME Keyring, KWallet) on Linux
//! and Credential Manager on Windows. None can list entries for us, so the names live in a small
//! JSON index in the app data dir, each with its policy: the sites it may be typed on and whether
//! the local runner may use it (security review A1). The index never holds a value.
//!
//! The shell hands the engine each secret with its policy (`attach_policies`, called by
//! `engine_request`), so the sites come from here, never from the UI or a test file.

use std::collections::BTreeMap;
use std::fs;
use crate::os_words::os_string;
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

/// The OS credential store through the `keyring` crate, one service per store (saved secrets:
/// `dev.breakpatch.secrets`; the licence: `dev.breakpatch.licence`). On Windows each value goes
/// through [`split`], because a Credential Manager entry holds at most 2,560 bytes.
pub struct KeyringStore {
    service: &'static str,
}

impl KeyringStore {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }
    fn entry(&self, name: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(self.service, name).map_err(store_error)
    }
}

impl Default for KeyringStore {
    fn default() -> Self {
        Self::new(SERVICE)
    }
}

#[cfg(not(windows))]
impl SecretStore for KeyringStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        match self.entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        self.entry(name)?.set_password(value).map_err(store_error)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

/// Windows: UTF-8 bytes (`set_secret`), not `set_password`'s UTF-16, which would halve what fits,
/// split over several entries when a value is longer than one may hold.
#[cfg(windows)]
impl split::Blobs for KeyringStore {
    fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match self.entry(name)?.get_secret() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(store_error(e)),
        }
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
        self.entry(name)?.set_secret(bytes).map_err(store_error)
    }
    fn remove(&self, name: &str) -> Result<(), String> {
        match self.entry(name)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(store_error(e)),
        }
    }
}

#[cfg(windows)]
impl SecretStore for KeyringStore {
    fn get(&self, name: &str) -> Result<Option<String>, String> {
        split::get(self, split::WINDOWS_LIMIT, name)
    }
    fn set(&self, name: &str, value: &str) -> Result<(), String> {
        split::set(self, split::WINDOWS_LIMIT, name, value)
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        split::delete(self, name)
    }
}

/// What to tell the person when the credential store failed. On Linux, no Secret Service on the
/// session bus (or a locked keyring whose prompt was dismissed) gets a plain message: secrets are
/// never kept in a file instead. Elsewhere, what the system said, as before.
fn store_error(e: keyring::Error) -> String {
    if cfg!(target_os = "linux") && matches!(e, keyring::Error::PlatformFailure(_) | keyring::Error::NoStorageAccess(_)) {
        log::warn!("the Secret Service refused or isn't there: {e}");
        return NO_KEYRING.into();
    }
    e.to_string()
}

/// Linux without a usable keyring.
pub const NO_KEYRING: &str = "Breakpatch keeps secrets in your keyring and couldn't reach one. Install or unlock a keyring such as GNOME Keyring or KWallet, then try again.";

/// Values longer than one credential store entry holds, split over several (Windows' Credential
/// Manager: 2,560 bytes an entry). A value that fits is kept as its UTF-8 bytes, as it is. A longer
/// one gets a head entry under its own name, `SPLIT` followed by the number of parts, and the parts
/// in `<name>#1`, `<name>#2`, …. The head can't be mistaken for a value: `SPLIT` starts with 0xFF,
/// which never occurs in UTF-8. Secret names never hold `#` ([`validate_name`]).
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub mod split {
    /// `CRED_MAX_CREDENTIAL_BLOB_SIZE`.
    pub const WINDOWS_LIMIT: usize = 2560;
    /// At most this many parts: 40 KB on Windows, far above any secret, licence or key.
    pub const MAX_PARTS: usize = 16;
    const SPLIT: &[u8] = b"\xFFbp-split-v1:";

    /// One entry's bytes, by name.
    pub trait Blobs {
        fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
        fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String>;
        fn remove(&self, name: &str) -> Result<(), String>;
    }

    fn part_name(name: &str, i: usize) -> String {
        format!("{name}#{i}")
    }

    /// How many parts a head entry names, or None for a value kept whole.
    fn parts_of(head: &[u8]) -> Option<Result<usize, String>> {
        let rest = head.strip_prefix(SPLIT)?;
        let n = std::str::from_utf8(rest).ok().and_then(|t| t.parse::<usize>().ok());
        Some(match n {
            Some(n) if (2..=MAX_PARTS).contains(&n) => Ok(n),
            _ => Err("A saved value is damaged. Save it again.".to_string()),
        })
    }

    pub fn get(store: &impl Blobs, limit: usize, name: &str) -> Result<Option<String>, String> {
        let Some(head) = store.read(name)? else { return Ok(None) };
        let bytes = match parts_of(&head) {
            None => head,
            Some(n) => {
                let n = n?;
                let mut all = Vec::with_capacity(n * limit);
                for i in 1..=n {
                    match store.read(&part_name(name, i))? {
                        Some(p) => all.extend_from_slice(&p),
                        None => return Err("Part of a saved value is missing. Save it again.".into()),
                    }
                }
                all
            }
        };
        String::from_utf8(bytes).map(Some).map_err(|_| "A saved value isn't readable. Save it again.".into())
    }

    pub fn set(store: &impl Blobs, limit: usize, name: &str, value: &str) -> Result<(), String> {
        let before = match store.read(name)? {
            Some(head) => parts_of(&head).and_then(Result::ok).unwrap_or(0),
            None => 0,
        };
        let bytes = value.as_bytes();
        let parts = if bytes.len() <= limit {
            store.write(name, bytes)?;
            0
        } else {
            let chunks: Vec<&[u8]> = bytes.chunks(limit).collect();
            if chunks.len() > MAX_PARTS {
                return Err(format!("That's too long to keep: up to {} KB.", MAX_PARTS * limit / 1024));
            }
            // The parts first, then the head that names them: until the head is written, a
            // reader still finds the old value whole (or the old head and its parts, rewritten).
            for (i, chunk) in chunks.iter().enumerate() {
                store.write(&part_name(name, i + 1), chunk)?;
            }
            let mut head = SPLIT.to_vec();
            head.extend_from_slice(chunks.len().to_string().as_bytes());
            store.write(name, &head)?;
            chunks.len()
        };
        for i in parts + 1..=before {
            store.remove(&part_name(name, i))?;
        }
        Ok(())
    }

    /// An in-memory store that refuses entries longer than `limit`, as Credential Manager does.
    #[cfg(test)]
    #[derive(Default)]
    pub struct MemBlobs {
        pub limit: usize,
        pub entries: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
    }

    #[cfg(test)]
    impl MemBlobs {
        pub fn new(limit: usize) -> Self {
            Self { limit, entries: Default::default() }
        }
        pub fn names(&self) -> Vec<String> {
            self.entries.lock().unwrap().keys().cloned().collect()
        }
        pub fn read_raw(&self, name: &str) -> Vec<u8> {
            self.entries.lock().unwrap().get(name).cloned().unwrap_or_default()
        }
    }

    #[cfg(test)]
    impl Blobs for MemBlobs {
        fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
            Ok(self.entries.lock().unwrap().get(name).cloned())
        }
        fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String> {
            if bytes.len() > self.limit {
                return Err(format!("{name}: {} bytes is over the {}-byte limit", bytes.len(), self.limit));
            }
            self.entries.lock().unwrap().insert(name.into(), bytes.to_vec());
            Ok(())
        }
        fn remove(&self, name: &str) -> Result<(), String> {
            self.entries.lock().unwrap().remove(name);
            Ok(())
        }
    }

    pub fn delete(store: &impl Blobs, name: &str) -> Result<(), String> {
        let parts = match store.read(name)? {
            Some(head) => parts_of(&head).and_then(Result::ok).unwrap_or(0),
            None => 0,
        };
        store.remove(name)?;
        for i in 1..=parts {
            store.remove(&part_name(name, i))?;
        }
        Ok(())
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
            return Err(os_string(format!("There's no saved secret {name} on this Mac.")));
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

#[cfg(test)]
mod split_tests {
    use super::split::{self, MemBlobs, MAX_PARTS, WINDOWS_LIMIT};

    #[test]
    fn a_value_that_fits_is_kept_whole_as_utf8() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        // 2,000 characters of UTF-8 (one byte each) fit, though as UTF-16 they'd be 4,000 bytes.
        let v = "a".repeat(2000);
        split::set(&s, WINDOWS_LIMIT, "K", &v).unwrap();
        assert_eq!(s.names(), ["K"]);
        assert_eq!(s.read_raw("K"), v.as_bytes());
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(v.as_str()));
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "missing").unwrap(), None);
    }

    #[test]
    fn exactly_the_limit_fits_and_one_byte_more_splits() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        split::set(&s, WINDOWS_LIMIT, "K", &"x".repeat(WINDOWS_LIMIT)).unwrap();
        assert_eq!(s.names(), ["K"]);
        split::set(&s, WINDOWS_LIMIT, "K", &"x".repeat(WINDOWS_LIMIT + 1)).unwrap();
        assert_eq!(s.names(), ["K", "K#1", "K#2"]);
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().unwrap().len(), WINDOWS_LIMIT + 1);
    }

    /// Multi-byte characters are cut mid-character between parts and joined back exactly.
    #[test]
    fn a_long_value_round_trips_across_parts() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        let v: String = "ñ€😀abc".repeat(800); // 10 bytes × 800 = 8,000 bytes
        assert!(v.len() > 3 * WINDOWS_LIMIT);
        split::set(&s, WINDOWS_LIMIT, "K", &v).unwrap();
        assert_eq!(s.names(), ["K", "K#1", "K#2", "K#3", "K#4"]);
        assert!(s.read_raw("K").starts_with(&[0xFF]), "the head can't be read as a UTF-8 value");
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(v.as_str()));
    }

    #[test]
    fn rewriting_shorter_removes_the_stale_parts_and_delete_removes_all() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        split::set(&s, WINDOWS_LIMIT, "K", &"y".repeat(3 * WINDOWS_LIMIT)).unwrap();
        split::set(&s, WINDOWS_LIMIT, "Other", "keep me").unwrap();
        assert_eq!(s.names(), ["K", "K#1", "K#2", "K#3", "Other"]);
        split::set(&s, WINDOWS_LIMIT, "K", &"z".repeat(WINDOWS_LIMIT + 5)).unwrap();
        assert_eq!(s.names(), ["K", "K#1", "K#2", "Other"]);
        split::set(&s, WINDOWS_LIMIT, "K", "short").unwrap();
        assert_eq!(s.names(), ["K", "Other"]);
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some("short"));
        split::set(&s, WINDOWS_LIMIT, "K", &"w".repeat(2 * WINDOWS_LIMIT)).unwrap();
        split::delete(&s, "K").unwrap();
        split::delete(&s, "never-there").unwrap();
        assert_eq!(s.names(), ["Other"]);
    }

    #[test]
    fn too_long_and_damaged_values_say_so() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        let err = split::set(&s, WINDOWS_LIMIT, "K", &"x".repeat(MAX_PARTS * WINDOWS_LIMIT + 1)).unwrap_err();
        assert!(err.contains("too long"), "{err}");
        assert!(s.names().is_empty(), "nothing is written when it can't all fit");

        split::set(&s, WINDOWS_LIMIT, "K", &"x".repeat(2 * WINDOWS_LIMIT + 1)).unwrap();
        s.entries.lock().unwrap().remove("K#2");
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("missing"));
        s.entries.lock().unwrap().insert("K".into(), b"\xFFbp-split-v1:99".to_vec());
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("damaged"));
    }

    #[test]
    fn no_keyring_on_linux_is_a_plain_message() {
        let e = super::store_error(keyring::Error::NoStorageAccess("locked".into()));
        if cfg!(target_os = "linux") {
            assert_eq!(e, super::NO_KEYRING);
        } else {
            assert!(e.contains("locked"));
        }
        // Anything else is passed on as the system said it.
        assert!(super::store_error(keyring::Error::TooLong("secret".into(), 2560)).contains("2560"));
    }
}

/// The real Secret Service on Linux: needs a session bus with an unlocked keyring, e.g.
/// `dbus-run-session -- sh -c 'echo pw | gnome-keyring-daemon --unlock --components=secrets; cargo test real_keyring -- --ignored'`
/// (`--unlock` creates the `login` keyring, the default collection, when there's none).
///
/// `no_keyring_message` needs no session bus at all. Unsetting `DBUS_SESSION_BUS_ADDRESS` isn't
/// enough: zbus then tries `$XDG_RUNTIME_DIR/bus`, and `/run/user/<uid>/bus` without that, where a
/// desktop or a CI runner has a bus that starts GNOME Keyring when asked. Point it at nothing:
/// `DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent cargo test no_keyring_message -- --ignored`.
#[cfg(all(test, target_os = "linux"))]
mod keyring_tests {
    use super::{KeyringStore, SecretStore, NO_KEYRING};

    const TEST_SERVICE: &str = "dev.breakpatch.test";

    #[test]
    #[ignore = "needs an unlocked Secret Service"]
    fn real_keyring_round_trip() {
        // The keyring crate first, for what the Secret Service said: the store turns any refusal
        // into NO_KEYRING.
        let probe = keyring::Entry::new(TEST_SERVICE, "PROBE").expect("an entry");
        probe.set_password("p").unwrap_or_else(|e| panic!("the Secret Service refused a new item: {e:?}"));
        probe.delete_credential().unwrap_or_else(|e| panic!("the Secret Service refused a delete: {e:?}"));

        let store = KeyringStore::new(TEST_SERVICE);
        let long = "s3cr3t-ñ-".repeat(1000);
        store.set("ROUND_TRIP", &long).unwrap();
        assert_eq!(store.get("ROUND_TRIP").unwrap().as_deref(), Some(long.as_str()));
        store.delete("ROUND_TRIP").unwrap();
        assert_eq!(store.get("ROUND_TRIP").unwrap(), None);
        store.delete("ROUND_TRIP").unwrap();
    }

    /// Tauri's async commands call the store on a tokio worker: zbus (async-io) must not need, or
    /// clash with, the runtime it's called from.
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs an unlocked Secret Service"]
    async fn real_keyring_from_a_tokio_worker() {
        let store = KeyringStore::new(TEST_SERVICE);
        store.set("FROM_TOKIO", "v").unwrap();
        assert_eq!(store.get("FROM_TOKIO").unwrap().as_deref(), Some("v"));
        store.delete("FROM_TOKIO").unwrap();
    }

    #[test]
    #[ignore = "needs no Secret Service on the session bus"]
    fn no_keyring_message() {
        let bus = std::env::var("DBUS_SESSION_BUS_ADDRESS")
            .unwrap_or_else(|_| "unset, so zbus tries $XDG_RUNTIME_DIR/bus".into());
        let store = KeyringStore::new(TEST_SERVICE);
        // A get first: if a Secret Service answers after all, nothing is written to it.
        match store.get("ANY") {
            Err(e) => assert_eq!(e, NO_KEYRING),
            Ok(v) => panic!(
                "a Secret Service answered on the session bus ({bus}) and gave {v:?}: run with \
                 DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent"
            ),
        }
        assert_eq!(store.set("ANY", "v").unwrap_err(), NO_KEYRING);
    }
}

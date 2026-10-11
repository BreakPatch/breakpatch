//! Saved secrets (spec §13): values in the OS credential store, service `dev.breakpatch.secrets`,
//! one entry per name: the Keychain on macOS, the Secret Service (GNOME Keyring, KWallet) on Linux
//! and Credential Manager on Windows. None can list entries for us, so the names live in a small
//! JSON index in the app data dir, each with its policy: the sites it may be typed on, whether
//! the local runner may use it (security review A1) and the workspaces it's kept for (issue #33:
//! none listed means every workspace). The index never holds a value.
//!
//! The shell hands the engine each secret with its policy (`attach_policies`, called by
//! `engine_request`), so the sites come from here, never from the UI or a test file.

use std::collections::BTreeMap;
use std::fs;
use crate::os_words::os_format;
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
/// one gets a head entry under its own name and the parts in `<name>#<generation>.1`,
/// `<name>#<generation>.2`, …. The head, `SPLIT` then `parts:generation:length:hash`, names the
/// parts and says how long the value is and the start of its SHA-256, which [`split::get`] checks:
/// parts from two different saves never read back as a value. Each save writes its parts under a
/// new generation, so a save that fails part way never touches the parts the head in place names,
/// and takes away the parts it wrote. The head can't be mistaken for a value: it starts with 0xFF,
/// which never occurs in UTF-8. Secret names never hold `#` ([`validate_name`]).
///
/// Heads from before (`SPLIT_V1` and a number, parts in `<name>#1`, …) are still read.
#[cfg_attr(not(any(test, windows)), allow(dead_code))]
pub mod split {
    use sha2::{Digest, Sha256};

    /// `CRED_MAX_CREDENTIAL_BLOB_SIZE`.
    pub const WINDOWS_LIMIT: usize = 2560;
    /// At most this many parts: 40 KB on Windows, far above any secret, licence or key.
    pub const MAX_PARTS: usize = 16;
    const SPLIT: &[u8] = b"\xFFbp-split-v2:";
    const SPLIT_V1: &[u8] = b"\xFFbp-split-v1:";
    const DAMAGED: &str = "A saved value is damaged. Save it again.";

    /// One entry's bytes, by name.
    pub trait Blobs {
        fn read(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
        fn write(&self, name: &str, bytes: &[u8]) -> Result<(), String>;
        fn remove(&self, name: &str) -> Result<(), String>;
    }

    /// What a head entry says.
    struct Head {
        parts: usize,
        /// 0 for a head from before generations (parts in `<name>#1`, …).
        generation: u32,
        /// The value's length and the start of its SHA-256 (hex); None in a head from before.
        check: Option<(usize, String)>,
    }

    fn part_name(name: &str, generation: u32, i: usize) -> String {
        if generation == 0 {
            format!("{name}#{i}")
        } else {
            format!("{name}#{generation}.{i}")
        }
    }

    fn part_names(name: &str, head: &Head) -> Vec<String> {
        (1..=head.parts).map(|i| part_name(name, head.generation, i)).collect()
    }

    /// The first 8 bytes of the value's SHA-256, in hex.
    fn short_hash(bytes: &[u8]) -> String {
        Sha256::digest(bytes)[..8].iter().map(|b| format!("{b:02x}")).collect()
    }

    /// What a head entry names, or None for a value kept whole.
    fn head_of(entry: &[u8]) -> Option<Result<Head, String>> {
        let parts_ok = |n: usize| (2..=MAX_PARTS).contains(&n);
        if let Some(rest) = entry.strip_prefix(SPLIT_V1) {
            let n = std::str::from_utf8(rest).ok().and_then(|t| t.parse::<usize>().ok());
            return Some(match n {
                Some(n) if parts_ok(n) => Ok(Head { parts: n, generation: 0, check: None }),
                _ => Err(DAMAGED.to_string()),
            });
        }
        let rest = entry.strip_prefix(SPLIT)?;
        let fields: Vec<&str> = std::str::from_utf8(rest).unwrap_or("").split(':').collect();
        let head = match fields[..] {
            [n, g, len, hash] => match (n.parse::<usize>(), g.parse::<u32>(), len.parse::<usize>()) {
                (Ok(n), Ok(g), Ok(len)) if parts_ok(n) && g > 0 && hash.len() == 16 => {
                    Some(Head { parts: n, generation: g, check: Some((len, hash.to_string())) })
                }
                _ => None,
            },
            _ => None,
        };
        Some(head.ok_or_else(|| DAMAGED.to_string()))
    }

    /// The head under `name`, if it is one (a damaged one reads as none: there's nothing to keep).
    fn head_in(store: &impl Blobs, name: &str) -> Result<Option<Head>, String> {
        Ok(store.read(name)?.and_then(|e| head_of(&e)).and_then(Result::ok))
    }

    pub fn get(store: &impl Blobs, limit: usize, name: &str) -> Result<Option<String>, String> {
        let Some(entry) = store.read(name)? else { return Ok(None) };
        let bytes = match head_of(&entry) {
            None => entry,
            Some(head) => {
                let head = head?;
                let mut all = Vec::with_capacity(head.parts * limit);
                for part in part_names(name, &head) {
                    match store.read(&part)? {
                        Some(p) => all.extend_from_slice(&p),
                        None => return Err("Part of a saved value is missing. Save it again.".into()),
                    }
                }
                if let Some((len, hash)) = &head.check {
                    if all.len() != *len || short_hash(&all) != *hash {
                        return Err(DAMAGED.into());
                    }
                }
                all
            }
        };
        String::from_utf8(bytes).map(Some).map_err(|_| "A saved value isn't readable. Save it again.".into())
    }

    pub fn set(store: &impl Blobs, limit: usize, name: &str, value: &str) -> Result<(), String> {
        let before = head_in(store, name)?;
        let bytes = value.as_bytes();
        if bytes.len() <= limit {
            store.write(name, bytes)?;
        } else {
            let chunks: Vec<&[u8]> = bytes.chunks(limit).collect();
            if chunks.len() > MAX_PARTS {
                return Err(format!("That's too long to keep: up to {} KB.", MAX_PARTS * limit / 1024));
            }
            // A new generation's parts, then the head that names them: until the head is
            // written, a reader still finds the old value, whole or in its own parts, untouched.
            let generation = match before.as_ref().map_or(0, |h| h.generation).wrapping_add(1) {
                0 => 1,
                g => g,
            };
            let head = Head { parts: chunks.len(), generation, check: Some((bytes.len(), short_hash(bytes))) };
            let names = part_names(name, &head);
            let undo = |written: &[String]| {
                for n in written {
                    if let Err(e) = store.remove(n) {
                        log::warn!("couldn't take away the part {n} of a save that failed: {e}");
                    }
                }
            };
            for (i, chunk) in chunks.iter().enumerate() {
                if let Err(e) = store.write(&names[i], chunk) {
                    undo(&names[..i]);
                    return Err(e);
                }
            }
            let (len, hash) = head.check.as_ref().expect("a check");
            let mut entry = SPLIT.to_vec();
            entry.extend_from_slice(format!("{}:{}:{len}:{hash}", head.parts, head.generation).as_bytes());
            if let Err(e) = store.write(name, &entry) {
                undo(&names);
                return Err(e);
            }
        }
        // The value is saved: the old parts are only clutter now.
        for part in before.map(|h| part_names(name, &h)).unwrap_or_default() {
            if let Err(e) = store.remove(&part) {
                log::warn!("couldn't remove the old part {part}: {e}");
            }
        }
        Ok(())
    }

    /// An in-memory store that refuses entries longer than `limit`, as Credential Manager does,
    /// and any write to a name that `fail_on` names (a store failing part way, for the tests).
    #[cfg(test)]
    #[derive(Default)]
    pub struct MemBlobs {
        pub limit: usize,
        pub entries: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
        pub fail_on: std::sync::Mutex<Option<String>>,
    }

    #[cfg(test)]
    impl MemBlobs {
        pub fn new(limit: usize) -> Self {
            Self { limit, ..Default::default() }
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
            if self.fail_on.lock().unwrap().as_deref() == Some(name) {
                return Err(format!("{name}: the store refused it"));
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
        let before = head_in(store, name)?;
        store.remove(name)?;
        for part in before.map(|h| part_names(name, &h)).unwrap_or_default() {
            store.remove(&part)?;
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
    /// The workspaces and tests folders it may be used in, by connection id (`team:<project>/<db>`,
    /// `hosted:<id>`, `local:<hash>`, `demo`: the app's connectionIds.ts). Empty: every one, as
    /// for every secret saved before the list existed. Left out of the file when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspaces: Vec<String>,
}

/// One saved secret as the UI sees it: the name and its policy, never the value.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecretInfo {
    pub name: String,
    pub origins: Vec<String>,
    pub runner_can_use: bool,
    /// Empty: every workspace.
    pub workspaces: Vec<String>,
}

/// The index file: `{"version": 2, "secrets": {"NAME": {"origins": [...], "runnerCanUse": false,
/// "workspaces": [...]}}}` (`workspaces` only when the secret is kept for some workspaces).
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

/// Most workspaces one secret can be kept for.
pub const MAX_WORKSPACES: usize = 50;

/// A connection id as the app makes them (connectionIds.ts): checked for shape only, since a
/// workspace that isn't on this Mac any more may still be on the list.
pub fn validate_workspace(id: &str) -> Result<&str, String> {
    let id = id.trim();
    if id.is_empty() || id.len() > 200 || id.contains('|') || id.chars().any(char::is_control) {
        return Err("That isn't a workspace.".into());
    }
    Ok(id)
}

/// Checked, de-duplicated workspace ids, in the order given.
pub fn normalize_workspaces(list: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for w in list {
        let w = validate_workspace(w)?;
        if !out.iter().any(|x| x == w) {
            out.push(w.to_string());
        }
    }
    if out.len() > MAX_WORKSPACES {
        return Err(format!("A secret can be kept for up to {MAX_WORKSPACES} workspaces."));
    }
    Ok(out)
}

impl Policy {
    /// Whether it may be used in `workspace` (the request's; None: unknown, so only a secret kept
    /// for every workspace).
    pub fn allowed_in(&self, workspace: Option<&str>) -> bool {
        self.workspaces.is_empty() || workspace.is_some_and(|w| self.workspaces.iter().any(|x| x == w))
    }
}

/// What the engine gets for a saved secret kept for other workspaces: the reason, never the value
/// (engine/PROTOCOL.md "Saved secrets").
pub fn refused_elsewhere(name: &str) -> Value {
    json!({ "refused": os_format!(
        "{name} is kept for other workspaces on this Mac, so it isn't used here. To use it here, add this workspace to it in Settings, Saved secrets.",
        name = name
    ) })
}

/// Engine methods whose params carry saved secrets (engine/PROTOCOL.md "Saved secrets"), and
/// `email.check` (Settings → Test inbox, Breakpatch Team): the inbox's password, used on its site only.
pub fn carries_secrets(method: &str) -> bool {
    matches!(method, "run.start" | "record.point" | "call.try" | "email.check")
}

/// Gives every secret in `params.secrets` the sites and runner flag from the index, replacing
/// whatever the caller sent: `{NAME: value}` or `{NAME: {value, ...}}` becomes
/// `{NAME: {value, origins, runnerCanUse}}`. A name the index doesn't know gets no sites, so the
/// engine types it nowhere. Entries without a value are dropped. A secret kept for other
/// workspaces than `workspace` (the open one, as the request says) becomes `{refused}` (#33).
pub fn attach_policies(params: &mut Value, index: &BTreeMap<String, Policy>, workspace: Option<&str>) {
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
        if !policy.allowed_in(workspace) {
            let refused = refused_elsewhere(&name);
            secrets.insert(name, refused);
            continue;
        }
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
            .map(|(name, p)| SecretInfo { name, origins: p.origins, runner_can_use: p.runner_can_use, workspaces: p.workspaces })
            .collect()
    }

    /// Name → policy, for `attach_policies`.
    pub fn policies(&self) -> BTreeMap<String, Policy> {
        let _g = self.lock.lock().unwrap();
        self.index.load()
    }

    /// Saves the value. `origins` / `runner_can_use` / `workspaces` set the policy; left out, each
    /// stays as it was (a new secret: no sites, runner off, every workspace).
    pub fn set(
        &self,
        name: &str,
        value: &str,
        origins: Option<Vec<String>>,
        runner_can_use: Option<bool>,
        workspaces: Option<Vec<String>>,
    ) -> Result<(), String> {
        let name = validate_name(name)?;
        let origins = origins.map(|o| normalize_origins(&o)).transpose()?;
        let workspaces = workspaces.map(|w| normalize_workspaces(&w)).transpose()?;
        let _g = self.lock.lock().unwrap();
        let before = self.index.load().get(name).cloned().unwrap_or_default();
        let policy = Policy {
            origins: origins.unwrap_or(before.origins),
            runner_can_use: runner_can_use.unwrap_or(before.runner_can_use),
            workspaces: workspaces.unwrap_or(before.workspaces),
        };
        self.store.set(name, value)?;
        self.index.put(name, Some(policy))
    }

    /// Changes where a saved secret may be used, without touching its value (no Keychain access).
    /// `workspaces` left out keeps the list as it is (an older UI that doesn't know it).
    pub fn set_policy(&self, name: &str, origins: Vec<String>, runner_can_use: bool, workspaces: Option<Vec<String>>) -> Result<(), String> {
        let name = validate_name(name)?;
        let origins = normalize_origins(&origins)?;
        let workspaces = workspaces.map(|w| normalize_workspaces(&w)).transpose()?;
        let _g = self.lock.lock().unwrap();
        let Some(before) = self.index.load().get(name).cloned() else {
            return Err(os_format!("There's no saved secret {name} on this Mac.", name = name));
        };
        self.index.put(name, Some(Policy { origins, runner_can_use, workspaces: workspaces.unwrap_or(before.workspaces) }))
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
        s.set(n, v, None, None, None).unwrap();
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
        s.set("TOKEN", "super-secret-value", Some(vec!["https://App.Example.com/login".into()]), Some(true), None).unwrap();
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
        assert!(s.set("bad name", "v", None, None, None).is_err());
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
        assert_eq!(s.info()[1], SecretInfo { name: "PROD_DB_PASSWORD".into(), origins: vec![], runner_can_use: false, workspaces: vec![] });
        // Allowing a site writes the new format; the names are all kept.
        s.set_policy("PROD_DB_PASSWORD", vec!["https://db.acme.com".into()], false, None).unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"version\": 2") && text.contains("ACME_TEST_EMAIL"));
        assert_eq!(s.info()[1].origins, vec!["https://db.acme.com"]);
    }

    #[test]
    fn changing_the_value_keeps_the_sites_and_the_policy_can_change_alone() {
        let (_d, s) = fixture();
        s.set("PW", "one", Some(vec!["https://app.acme.com".into()]), None, None).unwrap();
        set(&s, "PW", "two");
        assert_eq!(s.info()[0].origins, vec!["https://app.acme.com"]);
        assert!(!s.info()[0].runner_can_use, "the runner flag is off by default");
        s.set_policy("PW", vec!["https://a.acme.com".into(), "https://a.acme.com/x".into()], true, None).unwrap();
        assert_eq!(
            s.info()[0],
            SecretInfo { name: "PW".into(), origins: vec!["https://a.acme.com".into()], runner_can_use: true, workspaces: vec![] }
        );
        assert_eq!(s.resolve(&["PW".into()]).unwrap()["PW"], "two");
        assert!(s.set_policy("NOT_THERE", vec![], false, None).is_err());
        assert!(s.set_policy("PW", vec!["file:///etc".into()], false, None).is_err());
    }

    #[test]
    fn a_secret_s_name_is_never_reworded_for_the_computer() {
        let (_d, s) = fixture();
        let err = s.set_policy("Mac.tests", vec![], false, None).unwrap_err();
        let this = crate::os_words::os_text("this Mac");
        assert_eq!(err, format!("There's no saved secret Mac.tests on {this}."));
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
            ("PW".to_string(), Policy { origins: vec!["https://app.acme.com".into()], runner_can_use: true, workspaces: vec![] }),
            ("OLD".to_string(), Policy::default()),
        ]);
        let mut p = json!({ "runId": "r", "secrets": {
            "PW": "hunter2",
            "OLD": { "value": "x", "origins": ["https://evil.example"], "runnerCanUse": true },
            "UNKNOWN": "y",
            "BROKEN": 7,
        }});
        attach_policies(&mut p, &index, Some("team:acme/breakpatch"));
        assert_eq!(
            p["secrets"],
            json!({
                "PW": { "value": "hunter2", "origins": ["https://app.acme.com"], "runnerCanUse": true },
                "OLD": { "value": "x", "origins": [], "runnerCanUse": false },
                "UNKNOWN": { "value": "y", "origins": [], "runnerCanUse": false },
            })
        );
        let mut none = json!({ "runId": "r" });
        attach_policies(&mut none, &index, None);
        assert_eq!(none, json!({ "runId": "r" }));
        assert!(carries_secrets("run.start") && carries_secrets("record.point") && carries_secrets("call.try"));
        assert!(carries_secrets("email.check"));
        assert!(!carries_secrets("browser.open"));
    }

    // ---- Kept for chosen workspaces (issue #33) ----

    const ACME: &str = "team:acme-tests/breakpatch";
    const MINE: &str = "local:0123456789abcdef";

    #[test]
    fn a_secret_kept_for_some_workspaces_is_refused_in_the_others() {
        let index = BTreeMap::from([
            ("PW".to_string(), Policy { origins: vec!["https://app.acme.com".into()], runner_can_use: false, workspaces: vec![ACME.into()] }),
            ("ANY".to_string(), Policy { origins: vec!["https://app.acme.com".into()], runner_can_use: false, workspaces: vec![] }),
        ]);
        let sent = json!({ "secrets": { "PW": "hunter2", "ANY": "x" } });

        let mut here = sent.clone();
        attach_policies(&mut here, &index, Some(ACME));
        assert_eq!(here["secrets"]["PW"]["value"], "hunter2");

        let mut elsewhere = sent.clone();
        attach_policies(&mut elsewhere, &index, Some(MINE));
        assert_eq!(elsewhere["secrets"]["ANY"]["value"], "x", "a secret kept for every workspace works everywhere");
        let refused = &elsewhere["secrets"]["PW"];
        assert!(refused.get("value").is_none() && !elsewhere.to_string().contains("hunter2"), "the value never goes: {elsewhere}");
        assert!(refused["refused"].as_str().unwrap().starts_with("PW is kept for other workspaces"));

        // A request that doesn't say where it is gets only the secrets kept for every workspace.
        let mut unknown = sent;
        attach_policies(&mut unknown, &index, None);
        assert!(unknown["secrets"]["PW"].get("refused").is_some() && unknown["secrets"]["ANY"]["value"] == "x");
    }

    #[test]
    fn the_workspace_list_is_saved_changed_and_kept_when_left_out() {
        let (_d, s) = fixture();
        s.set("PW", "one", Some(vec!["https://app.acme.com".into()]), None, Some(vec![ACME.into(), format!(" {ACME} "), MINE.into()])).unwrap();
        assert_eq!(s.info()[0].workspaces, vec![ACME, MINE], "trimmed and de-duplicated");
        // A new value, or sites alone from an older UI, keep the list.
        set(&s, "PW", "two");
        s.set_policy("PW", vec!["https://app.acme.com".into()], true, None).unwrap();
        assert_eq!(s.info()[0].workspaces, vec![ACME, MINE]);
        // Every workspace again.
        s.set_policy("PW", vec!["https://app.acme.com".into()], true, Some(vec![])).unwrap();
        assert!(s.info()[0].workspaces.is_empty());
        let text = fs::read_to_string(s.index.path()).unwrap();
        assert!(!text.contains("workspaces"), "an empty list isn't written, so the file reads as before: {text}");
        assert!(s.set_policy("PW", vec![], false, Some(vec!["bad|id".into()])).is_err());
        assert!(s.set_policy("PW", vec![], false, Some(vec![" ".into()])).is_err());
        let many: Vec<String> = (0..=MAX_WORKSPACES).map(|i| format!("local:{i:016x}")).collect();
        assert!(s.set_policy("PW", vec![], false, Some(many)).is_err());
    }

    #[test]
    fn an_index_from_before_workspace_lists_keeps_every_secret_everywhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets-index.json");
        fs::write(&path, r#"{"version": 2, "secrets": {"PW": {"origins": ["https://app.acme.com"], "runnerCanUse": true}}}"#).unwrap();
        let s = Secrets::new(MemStore::default(), SecretsIndex::new(path));
        let p = &s.policies()["PW"];
        assert!(p.workspaces.is_empty() && p.allowed_in(Some(ACME)) && p.allowed_in(None));
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
        assert_eq!(s.names(), ["K", "K#1.1", "K#1.2"]);
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().unwrap().len(), WINDOWS_LIMIT + 1);
    }

    /// Multi-byte characters are cut mid-character between parts and joined back exactly.
    #[test]
    fn a_long_value_round_trips_across_parts() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        let v: String = "ñ€😀abc".repeat(800); // 10 bytes × 800 = 8,000 bytes
        assert!(v.len() > 3 * WINDOWS_LIMIT);
        split::set(&s, WINDOWS_LIMIT, "K", &v).unwrap();
        assert_eq!(s.names(), ["K", "K#1.1", "K#1.2", "K#1.3", "K#1.4"]);
        assert!(s.read_raw("K").starts_with(&[0xFF]), "the head can't be read as a UTF-8 value");
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(v.as_str()));
    }

    #[test]
    fn rewriting_shorter_removes_the_stale_parts_and_delete_removes_all() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        split::set(&s, WINDOWS_LIMIT, "K", &"y".repeat(3 * WINDOWS_LIMIT)).unwrap();
        split::set(&s, WINDOWS_LIMIT, "Other", "keep me").unwrap();
        assert_eq!(s.names(), ["K", "K#1.1", "K#1.2", "K#1.3", "Other"]);
        split::set(&s, WINDOWS_LIMIT, "K", &"z".repeat(WINDOWS_LIMIT + 5)).unwrap();
        assert_eq!(s.names(), ["K", "K#2.1", "K#2.2", "Other"]);
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
        s.entries.lock().unwrap().remove("K#1.2");
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("missing"));
        s.entries.lock().unwrap().insert("K".into(), b"\xFFbp-split-v1:99".to_vec());
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("damaged"));
        s.entries.lock().unwrap().insert("K".into(), b"\xFFbp-split-v2:3:1:9".to_vec());
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("damaged"));
    }

    /// A part that isn't the one the head was written with (another save's, or changed) is found
    /// out by the head's length and hash, never read back as the value.
    #[test]
    fn parts_from_another_save_read_as_damaged() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        split::set(&s, WINDOWS_LIMIT, "K", &"a".repeat(3 * WINDOWS_LIMIT)).unwrap();
        s.entries.lock().unwrap().insert("K#1.2".into(), "b".repeat(WINDOWS_LIMIT).into_bytes());
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("damaged"));
        s.entries.lock().unwrap().insert("K#1.2".into(), "a".repeat(WINDOWS_LIMIT - 1).into_bytes());
        assert!(split::get(&s, WINDOWS_LIMIT, "K").unwrap_err().contains("damaged"));
    }

    /// The store refuses the second part of a new value: the old one reads back whole and as it
    /// was, and the part that was written is taken away again.
    #[test]
    fn a_save_that_fails_on_its_second_part_leaves_the_old_value() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        let old = format!("{}{}{}", "a".repeat(WINDOWS_LIMIT), "b".repeat(WINDOWS_LIMIT), "c".repeat(10));
        split::set(&s, WINDOWS_LIMIT, "K", &old).unwrap();
        let names = s.names();
        *s.fail_on.lock().unwrap() = Some("K#2.2".into());
        let new = "z".repeat(3 * WINDOWS_LIMIT);
        assert!(split::set(&s, WINDOWS_LIMIT, "K", &new).unwrap_err().contains("refused"));
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(old.as_str()));
        assert_eq!(s.names(), names, "the new value's first part is gone again");
        // The head itself refused: the same.
        *s.fail_on.lock().unwrap() = Some("K".into());
        assert!(split::set(&s, WINDOWS_LIMIT, "K", &new).is_err());
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(old.as_str()));
        assert_eq!(s.names(), names);
        *s.fail_on.lock().unwrap() = None;
        split::set(&s, WINDOWS_LIMIT, "K", &new).unwrap();
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(new.as_str()));
    }

    /// A value saved before heads had a check (parts in `K#1`, …): still read, and a failed save
    /// over it leaves it as it was.
    #[test]
    fn a_value_split_the_old_way_reads_and_survives_a_failed_save() {
        let s = MemBlobs::new(WINDOWS_LIMIT);
        let old = format!("{}{}", "a".repeat(WINDOWS_LIMIT), "b".repeat(5));
        {
            let mut e = s.entries.lock().unwrap();
            e.insert("K".into(), b"\xFFbp-split-v1:2".to_vec());
            e.insert("K#1".into(), "a".repeat(WINDOWS_LIMIT).into_bytes());
            e.insert("K#2".into(), b"bbbbb".to_vec());
        }
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(old.as_str()));
        *s.fail_on.lock().unwrap() = Some("K#1.2".into());
        assert!(split::set(&s, WINDOWS_LIMIT, "K", &"z".repeat(2 * WINDOWS_LIMIT)).is_err());
        assert_eq!(split::get(&s, WINDOWS_LIMIT, "K").unwrap().as_deref(), Some(old.as_str()));
        *s.fail_on.lock().unwrap() = None;
        split::set(&s, WINDOWS_LIMIT, "K", &"z".repeat(2 * WINDOWS_LIMIT)).unwrap();
        assert_eq!(s.names(), ["K", "K#1.1", "K#1.2"]);
        split::delete(&s, "K").unwrap();
        assert!(s.names().is_empty());
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

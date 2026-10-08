//! Workspace secrets (issue #45): a saved secret an admin keeps in a Breakpatch Team workspace, so
//! every member's runs and recordings, and the local runner, can use it without anyone typing it on
//! each Mac. breakpatch-ci can too, when the admin allows it (the Team engine's ci_secrets.py reads
//! the same documents). The docs: docs/manual.md "Workspace secrets".
//!
//! **Where it is.** The document `secrets/<id>` in the workspace (`<id>`: letters and digits, made
//! by the app):
//! - `info`: `{ enc, kid }`, the sealed `{ name, origins, runnerCanUse, ciCanUse }`. A content field
//!   (the Team repo's firebase/rules/content.json): the app opens it like a test's name, to list the
//!   workspace's secrets. It never holds the value.
//! - `value`: `{ enc, kid }`, the sealed `{ v: 1, name, value, origins, runnerCanUse, ciCanUse }`.
//!   Sealed only by [`seal`] and opened only by [`open_for_engine`] (from `engine_request`), so the
//!   value never reaches the UI: workspace_keys.rs `seal` and `open` refuse this field.
//! - `runner`, `ci`: plain copies of the two flags, for the rules (the runner and CI may read only
//!   the secrets they may use). The flags that count are the sealed ones.
//!
//! Both are workspace_keys.rs content fields: the workspace's data key, and the associated data
//! `bp-field-v1|<ws>|secrets/<id>|<field>|<kid>`, so a sealed value can't be moved to another
//! secret, field or workspace, and nobody without the key can change its sites. No new cryptography.
//!
//! **Which one a request uses.** `engine_request` takes `workspace` (the open connection's id) and
//! `workspaceSecrets` (`[{ name, id, enc, kid }]`: the sealed values the Team module read for the
//! names the test uses) out of the params ([`take_scope`]). A secret on this Mac that's allowed in
//! that workspace wins (secrets.rs `attach_policies`); otherwise the workspace's, opened here, goes
//! to the engine with the sites and runner flag sealed with it. One that doesn't open goes as
//! `{ refused }`, with the reason ([`merge`]).

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::os_words::os_format;
use crate::secrets::{normalize_origins, validate_name, validate_workspace, SecretStore, Secrets};
use crate::workspace_keys::{Blob, WorkspaceKeys};

/// The collection, and the two sealed fields of a secret's document.
pub const COLLECTION: &str = "secrets";
pub const VALUE_FIELD: &str = "value";
pub const INFO_FIELD: &str = "info";
/// The longest value a workspace secret may have (UTF-8 bytes).
pub const MAX_VALUE_BYTES: usize = 4096;
/// The most workspace secrets one request (or one reseal) handles.
pub const MAX_SECRETS: usize = 200;

/// Whether a field is a workspace secret's value: workspace_keys.rs `seal` and `open` refuse it.
pub fn is_secret_value(path: &str, field: &str) -> bool {
    field == VALUE_FIELD && path.starts_with("secrets/")
}

/// `secrets/<id>`, for an id the app made (letters and digits, up to 40).
pub fn path_of(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 40 || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("That isn't a workspace secret.".into());
    }
    Ok(format!("{COLLECTION}/{id}"))
}

/// What `value` holds, sealed.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Payload {
    v: u32,
    name: String,
    value: String,
    origins: Vec<String>,
    #[serde(default)]
    runner_can_use: bool,
    #[serde(default)]
    ci_can_use: bool,
}

impl Drop for Payload {
    fn drop(&mut self) {
        self.value.zeroize();
    }
}

/// What `info` holds, sealed: everything but the value.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub name: String,
    pub origins: Vec<String>,
    #[serde(default)]
    pub runner_can_use: bool,
    #[serde(default)]
    pub ci_can_use: bool,
}

/// A sealed field as stored.
#[derive(Deserialize, Debug, Clone)]
pub struct Field {
    pub enc: String,
    pub kid: u32,
}

/// An admin saves a workspace secret (Settings → Saved secrets → the workspace's secrets).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Save {
    pub id: String,
    pub name: String,
    /// A new value. Left out: the value sealed in `old` stays, or, with `from_mac`, the value of this
    /// Mac's saved secret of the same name is taken from the Keychain ("Share with the workspace").
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub from_mac: bool,
    /// The document's `value` as stored, when the secret is there already.
    #[serde(default)]
    pub old: Option<Field>,
    pub origins: Vec<String>,
    #[serde(default)]
    pub runner_can_use: bool,
    #[serde(default)]
    pub ci_can_use: bool,
}

impl Drop for Save {
    fn drop(&mut self) {
        if let Some(v) = self.value.as_mut() {
            v.zeroize();
        }
    }
}

/// The two sealed fields to store.
#[derive(Serialize, Debug)]
pub struct Sealed {
    pub info: Blob,
    pub value: Blob,
}

fn open_payload<S: SecretStore>(keys: &WorkspaceKeys<S>, ws: &str, path: &str, f: &Field) -> Result<Payload, String> {
    let bytes = keys.open_reserved(ws, path, VALUE_FIELD, f.kid, &f.enc)?;
    let p: Payload = serde_json::from_slice(&bytes).map_err(|_| "The workspace secret is damaged. An admin saves it again.".to_string())?;
    if p.v != 1 || validate_name(&p.name).is_err() {
        return Err("The workspace secret is damaged. An admin saves it again.".into());
    }
    Ok(p)
}

/// Seals a workspace secret with key `kid` (None: the newest this Mac holds): its value and its
/// info, from a name, sites and flags checked as this Mac's own secrets are. `mac`: this Mac's saved
/// secrets, for `from_mac`.
pub fn seal<S: SecretStore, L: SecretStore>(keys: &WorkspaceKeys<S>, mac: Option<&Secrets<L>>, ws: &str, kid: Option<u32>, save: &Save) -> Result<Sealed, String> {
    validate_workspace(ws)?;
    let path = path_of(&save.id)?;
    let name = validate_name(&save.name)?.to_string();
    let origins = normalize_origins(&save.origins)?;
    if origins.is_empty() {
        return Err("Add the sites it may be typed on: at least one.".into());
    }
    let value: Zeroizing<String> = match (save.value.as_deref(), save.from_mac, save.old.as_ref()) {
        (Some(v), _, _) if !v.is_empty() => Zeroizing::new(v.to_string()),
        (_, true, _) => {
            let mut got = mac.ok_or("This Mac's saved secrets can't be read here.")?.resolve(std::slice::from_ref(&name))?;
            Zeroizing::new(got.remove(&name).ok_or_else(|| os_format!("There's no saved secret {name} on this Mac.", name = name))?)
        }
        (_, _, Some(old)) => {
            let p = open_payload(keys, ws, &path, old)?;
            if p.name != name {
                return Err("A workspace secret's name can't change. Add a new one instead.".into());
            }
            Zeroizing::new(p.value.clone())
        }
        _ => return Err("Type the secret's value.".into()),
    };
    if value.len() > MAX_VALUE_BYTES {
        return Err(format!("That's too long for a workspace secret: up to {} KB.", MAX_VALUE_BYTES / 1024));
    }
    let payload = Payload { v: 1, name: name.clone(), value: value.to_string(), origins: origins.clone(), runner_can_use: save.runner_can_use, ci_can_use: save.ci_can_use };
    let json = Zeroizing::new(serde_json::to_vec(&payload).map_err(|e| e.to_string())?);
    let value = keys.seal_reserved(ws, kid, &path, VALUE_FIELD, &json)?;
    let info = Info { name, origins, runner_can_use: save.runner_can_use, ci_can_use: save.ci_can_use };
    let info = keys.seal_reserved(ws, Some(value.kid), &path, INFO_FIELD, &serde_json::to_vec(&info).map_err(|e| e.to_string())?)?;
    Ok(Sealed { info, value })
}

/// A secret's `value` to seal again (a new key version: the reseal job).
#[derive(Deserialize, Debug, Clone)]
pub struct ResealItem {
    pub id: String,
    pub enc: String,
    pub kid: u32,
}

/// Each value sealed again with key `kid`, never leaving the shell: None for one this Mac can't open
/// (sealed with a key version it doesn't hold, or damaged), which stays as it is.
pub fn reseal<S: SecretStore>(keys: &WorkspaceKeys<S>, ws: &str, kid: u32, items: &[ResealItem]) -> Result<Vec<Option<Blob>>, String> {
    validate_workspace(ws)?;
    if items.len() > MAX_SECRETS {
        return Err("Too many workspace secrets at once.".into());
    }
    Ok(items
        .iter()
        .map(|i| {
            let path = path_of(&i.id).ok()?;
            let p = open_payload(keys, ws, &path, &Field { enc: i.enc.clone(), kid: i.kid }).ok()?;
            let json = Zeroizing::new(serde_json::to_vec(&p).ok()?);
            keys.seal_reserved(ws, Some(kid), &path, VALUE_FIELD, &json).ok()
        })
        .collect())
}

/// A workspace secret a request names: what the Team module read from `secrets/<id>`.
#[derive(Deserialize, Debug, Clone)]
pub struct EngineRef {
    pub name: String,
    pub id: String,
    pub enc: String,
    pub kid: u32,
}

/// What `engine_request` takes out of a request's params: where it runs, and the workspace
/// secrets it may use there.
#[derive(Debug, Default)]
pub struct Scope {
    pub workspace: Option<String>,
    pub refs: Vec<EngineRef>,
}

/// Takes `workspace` and `workspaceSecrets` out of the params (the engine never sees them). A
/// workspace id that isn't one counts as none; unreadable refs as none.
pub fn take_scope(params: &mut Value) -> Scope {
    let Some(o) = params.as_object_mut() else { return Scope::default() };
    let workspace = o
        .remove("workspace")
        .and_then(|v| v.as_str().map(str::to_string))
        .filter(|w| validate_workspace(w).is_ok() && w.trim() == w);
    let mut refs: Vec<EngineRef> = o.remove("workspaceSecrets").and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default();
    refs.truncate(MAX_SECRETS);
    Scope { workspace, refs }
}

/// Opens the workspace secrets a request names, for the engine: each one's `{ value, origins,
/// runnerCanUse }`, or why it can't be used, by name.
pub fn open_for_engine<S: SecretStore>(keys: &WorkspaceKeys<S>, ws: &str, refs: &[EngineRef]) -> Vec<(String, Result<Value, String>)> {
    refs.iter()
        .take(MAX_SECRETS)
        .map(|r| {
            let got = (|| {
                let path = path_of(&r.id)?;
                let p = open_payload(keys, ws, &path, &Field { enc: r.enc.clone(), kid: r.kid }).map_err(|e| {
                    if e.contains("doesn't hold") {
                        os_format!(
                            "The workspace secret {name} can't be opened on this Mac yet: it doesn't have the workspace's newest key. Settings → Workspace → Encryption says how to get it.",
                            name = r.name
                        )
                    } else {
                        os_format!("The workspace secret {name} can't be opened on this Mac. An admin saves it again.", name = r.name)
                    }
                })?;
                if p.name != r.name {
                    return Err(format!("The workspace secret {} isn't the one the test asked for.", r.name));
                }
                Ok(json!({ "value": p.value, "origins": p.origins, "runnerCanUse": p.runner_can_use }))
            })();
            (r.name.clone(), got)
        })
        .collect()
}

/// Adds the opened workspace secrets to `params.secrets`. A secret on this Mac allowed here (one
/// with a value) wins; one kept for other workspaces (`refused`) gives way to the workspace's.
pub fn merge(params: &mut Value, opened: Vec<(String, Result<Value, String>)>) {
    if opened.is_empty() {
        return;
    }
    let Some(o) = params.as_object_mut() else { return };
    let secrets = o.entry("secrets").or_insert_with(|| Value::Object(Map::new()));
    if !secrets.is_object() {
        *secrets = Value::Object(Map::new());
    }
    let secrets = secrets.as_object_mut().expect("an object");
    for (name, got) in opened {
        if secrets.get(&name).is_some_and(|v| v.get("value").is_some()) {
            continue;
        }
        secrets.insert(name, got.unwrap_or_else(|why| json!({ "refused": why })));
    }
}

// ---- Tauri commands (the Team module's secrets/store.ts) ----------------------------------------

pub mod commands {
    use super::*;
    use crate::workspace_keys::commands::KeysState;
    use std::sync::Arc;
    use tauri::State;

    async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
    }

    /// Seals a workspace secret for an admin to save: its two fields, never the value back.
    #[tauri::command]
    pub async fn workspace_secret_seal(
        k: State<'_, KeysState>,
        s: State<'_, crate::SecretsState>,
        ws: String,
        kid: Option<u32>,
        secret: Save,
    ) -> Result<Sealed, String> {
        let k = Arc::clone(&k);
        let s = Arc::clone(&s);
        blocking(move || seal(&k, Some(&*s), &ws, kid, &secret)).await
    }

    /// Seals workspace secrets' values again with key `kid` (the reseal job after a new key).
    #[tauri::command]
    pub async fn workspace_secret_reseal(k: State<'_, KeysState>, ws: String, kid: u32, items: Vec<ResealItem>) -> Result<Vec<Option<Blob>>, String> {
        let k = Arc::clone(&k);
        blocking(move || reseal(&k, &ws, kid, &items)).await
    }
}

#[cfg(test)]
#[path = "workspace_secrets_tests.rs"]
mod tests;

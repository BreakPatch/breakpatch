use super::*;
use crate::secrets::SecretsIndex;
use crate::workspace_keys::{seal_field_with, OpenItem, SealItem};
use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use std::collections::HashMap;
use std::sync::Mutex;

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

const WS: &str = "team:acme-tests/breakpatch";
const ID: &str = "Xk2p9QbW7rT1";

/// An admin's Mac holding the workspace's key version 1.
fn admin() -> WorkspaceKeys<MemStore> {
    let k = WorkspaceKeys::new(MemStore::default());
    k.create(WS, None).unwrap();
    k
}

fn save(name: &str, value: Option<&str>, origins: &[&str]) -> Save {
    Save {
        id: ID.into(),
        name: name.into(),
        value: value.map(str::to_string),
        from_mac: false,
        old: None,
        origins: origins.iter().map(|o| o.to_string()).collect(),
        runner_can_use: false,
        ci_can_use: false,
    }
}

fn no_mac() -> Option<&'static Secrets<MemStore>> {
    None
}

fn eref(name: &str, id: &str, b: &Blob) -> EngineRef {
    EngineRef { name: name.into(), id: id.into(), enc: b.enc.clone(), kid: b.kid }
}

fn field(b: &Blob) -> Field {
    Field { enc: b.enc.clone(), kid: b.kid }
}

#[test]
fn a_secret_s_value_opens_for_the_engine_only() {
    let k = admin();
    let mut s = save("ACME_PASSWORD", Some("hunter2"), &["https://App.acme.com/login"]);
    s.runner_can_use = true;
    let sealed = seal(&k, no_mac(), WS, None, &s).unwrap();
    assert_eq!((sealed.value.kid, sealed.info.kid), (1, 1));

    // The engine gets the value with the sites and the runner flag sealed with it.
    let got = open_for_engine(&k, WS, &[eref("ACME_PASSWORD", ID, &sealed.value)]);
    assert_eq!(got[0].0, "ACME_PASSWORD");
    assert_eq!(got[0].1.as_ref().unwrap(), &json!({ "value": "hunter2", "origins": ["https://app.acme.com"], "runnerCanUse": true }));

    // The UI's commands never open or make the value…
    let path = format!("secrets/{ID}");
    let as_ui = k.open(WS, &[OpenItem { path: path.clone(), field: "value".into(), enc: sealed.value.enc.clone(), kid: 1 }]).unwrap();
    assert_eq!(as_ui, vec![None]);
    assert!(k.seal(WS, None, &[SealItem { path: path.clone(), field: "value".into(), value: "{}".into() }]).is_err());
    // …but the info opens like any content, and holds no value.
    let info = k.open(WS, &[OpenItem { path, field: "info".into(), enc: sealed.info.enc.clone(), kid: 1 }]).unwrap();
    let info: Info = serde_json::from_str(info[0].as_deref().unwrap()).unwrap();
    assert_eq!(info, Info { name: "ACME_PASSWORD".into(), origins: vec!["https://app.acme.com".into()], runner_can_use: true, ci_can_use: false });
    assert!(!format!("{sealed:?}").contains("hunter2"));
}

#[test]
fn a_sealed_value_opens_only_in_its_own_place() {
    let k = admin();
    let sealed = seal(&k, no_mac(), WS, None, &save("PW", Some("hunter2"), &["https://app.acme.com"])).unwrap();
    // Copied to another secret's document, or put in place of its info: it doesn't open.
    let moved = open_for_engine(&k, WS, &[eref("PW", "Other1", &sealed.value)]);
    assert!(moved[0].1.as_ref().unwrap_err().contains("can't be opened"));
    let as_info = k.open(WS, &[OpenItem { path: format!("secrets/{ID}"), field: "info".into(), enc: sealed.value.enc.clone(), kid: 1 }]).unwrap();
    assert_eq!(as_info, vec![None]);
    // Another workspace's Mac with its own key can't open it either.
    let other = WorkspaceKeys::new(MemStore::default());
    other.create("hosted:w_other", None).unwrap();
    let there = open_for_engine(&other, "hosted:w_other", &[eref("PW", ID, &sealed.value)]);
    assert!(there[0].1.is_err());
    // Named as another secret: refused, never handed over under that name.
    let renamed = open_for_engine(&k, WS, &[eref("ADMIN_TOKEN", ID, &sealed.value)]);
    assert_eq!(renamed[0].1.as_ref().unwrap_err(), "The workspace secret ADMIN_TOKEN isn't the one the test asked for.");
    // A Mac without the key says so plainly.
    let member = WorkspaceKeys::new(MemStore::default());
    let locked = open_for_engine(&member, WS, &[eref("PW", ID, &sealed.value)]);
    assert!(locked[0].1.as_ref().unwrap_err().contains("doesn't have the workspace's newest key"), "{locked:?}");
}

#[test]
fn changing_the_sites_keeps_the_value_and_sharing_takes_it_from_the_keychain() {
    let k = admin();
    let first = seal(&k, no_mac(), WS, None, &save("PW", Some("hunter2"), &["https://app.acme.com"])).unwrap();
    // New sites and the runner flag, no value typed: the old value stays.
    let mut again = save("PW", None, &["https://app.acme.com", "https://staging.acme.com"]);
    again.old = Some(field(&first.value));
    again.runner_can_use = true;
    let second = seal(&k, no_mac(), WS, None, &again).unwrap();
    let got = open_for_engine(&k, WS, &[eref("PW", ID, &second.value)]);
    assert_eq!(got[0].1.as_ref().unwrap()["value"], "hunter2");
    assert_eq!(got[0].1.as_ref().unwrap()["origins"], json!(["https://app.acme.com", "https://staging.acme.com"]));
    // The name can't change under the same value.
    let mut renamed = save("OTHER", None, &["https://app.acme.com"]);
    renamed.old = Some(field(&first.value));
    assert!(seal(&k, no_mac(), WS, None, &renamed).unwrap_err().contains("can't change"));

    // "Share with the workspace": the value comes from this Mac's Keychain, never from the UI.
    let dir = tempfile::tempdir().unwrap();
    let mine = Secrets::new(MemStore::default(), SecretsIndex::new(dir.path().join("index.json")));
    mine.set("PW", "from-keychain", Some(vec!["https://app.acme.com".into()]), None, None).unwrap();
    let mut shared = save("PW", None, &["https://app.acme.com"]);
    shared.from_mac = true;
    let third = seal(&k, Some(&mine), WS, None, &shared).unwrap();
    assert_eq!(open_for_engine(&k, WS, &[eref("PW", ID, &third.value)])[0].1.as_ref().unwrap()["value"], "from-keychain");
    let mut missing = save("NOT_HERE", None, &["https://app.acme.com"]);
    missing.from_mac = true;
    assert!(seal(&k, Some(&mine), WS, None, &missing).unwrap_err().contains("There's no saved secret NOT_HERE"));
}

#[test]
fn what_an_admin_saves_is_checked() {
    let k = admin();
    let bad = |s: Save| seal(&k, no_mac(), WS, None, &s).unwrap_err();
    assert!(bad(save("PW", Some("x"), &[])).contains("at least one"));
    assert!(bad(save("PW", Some("x"), &["file:///etc/passwd"])).contains("isn't a web address"));
    assert!(bad(save("bad name", Some("x"), &["https://a.acme.com"])).contains("secret names"));
    assert!(bad(save("PW", Some(""), &["https://a.acme.com"])).contains("Type the secret's value"));
    assert!(bad(save("PW", None, &["https://a.acme.com"])).contains("Type the secret's value"));
    assert!(bad(save("PW", Some(&"x".repeat(MAX_VALUE_BYTES + 1)), &["https://a.acme.com"])).contains("too long"));
    let mut wrong_id = save("PW", Some("x"), &["https://a.acme.com"]);
    wrong_id.id = "../apps/x".into();
    assert!(bad(wrong_id).contains("isn't a workspace secret"));
    assert!(seal(&k, no_mac(), "bad|ws", None, &save("PW", Some("x"), &["https://a.acme.com"])).is_err());
    // A Mac without the key can't save one.
    let member = WorkspaceKeys::new(MemStore::default());
    assert!(seal(&member, no_mac(), WS, None, &save("PW", Some("x"), &["https://a.acme.com"])).is_err());
}

#[test]
fn a_new_key_version_seals_the_values_again_and_the_old_key_can_go() {
    let k = admin();
    let old = seal(&k, no_mac(), WS, None, &save("PW", Some("hunter2"), &["https://app.acme.com"])).unwrap();
    k.rotate(WS).unwrap();
    let items = [
        ResealItem { id: ID.into(), enc: old.value.enc.clone(), kid: 1 },
        ResealItem { id: "Other1".into(), enc: old.value.enc.clone(), kid: 1 },
    ];
    let again = reseal(&k, WS, 2, &items).unwrap();
    assert!(again[1].is_none(), "one that doesn't open where it's said to be stays as it is");
    let new = again[0].clone().unwrap();
    assert_eq!(new.kid, 2);
    k.retire(WS, 2).unwrap();
    assert!(open_for_engine(&k, WS, &[eref("PW", ID, &old.value)])[0].1.is_err());
    assert_eq!(open_for_engine(&k, WS, &[eref("PW", ID, &new)])[0].1.as_ref().unwrap()["value"], "hunter2");
    assert!(reseal(&k, WS, 2, &vec![items[0].clone(); MAX_SECRETS + 1]).is_err());
}

#[test]
fn a_secret_on_this_mac_wins_unless_it_s_kept_for_other_workspaces() {
    let k = admin();
    let pw = seal(&k, no_mac(), WS, None, &save("PW", Some("from-workspace"), &["https://app.acme.com"])).unwrap();
    let mut s2 = save("TOKEN", Some("workspace-token"), &["https://api.acme.com"]);
    s2.id = "Tok2".into();
    let tok = seal(&k, no_mac(), WS, None, &s2).unwrap();
    let mut s3 = save("API_KEY", Some("workspace-key"), &["https://api.acme.com"]);
    s3.id = "Key3".into();
    let key = seal(&k, no_mac(), WS, None, &s3).unwrap();

    let mut params = json!({
        "runId": "r",
        "workspace": WS,
        "workspaceSecrets": [
            { "name": "PW", "id": ID, "enc": pw.value.enc, "kid": 1 },
            { "name": "TOKEN", "id": "Tok2", "enc": tok.value.enc, "kid": 1 },
            { "name": "API_KEY", "id": "Key3", "enc": key.value.enc, "kid": 1 },
            { "name": "BROKEN", "id": "Brk4", "enc": "AAAA", "kid": 1 },
        ],
        "secrets": {
            "PW": { "value": "from-this-mac", "origins": ["https://app.acme.com"], "runnerCanUse": false },
            "TOKEN": { "refused": "TOKEN is kept for other workspaces on this Mac." },
        },
    });
    let scope = take_scope(&mut params);
    assert_eq!(scope.workspace.as_deref(), Some(WS));
    assert!(params.get("workspace").is_none() && params.get("workspaceSecrets").is_none(), "the engine never sees them");
    merge(&mut params, open_for_engine(&k, WS, &scope.refs));
    let s = &params["secrets"];
    assert_eq!(s["PW"]["value"], "from-this-mac", "this Mac's wins");
    assert_eq!(s["TOKEN"]["value"], "workspace-token", "kept for other workspaces: the workspace's is used");
    assert_eq!(s["API_KEY"], json!({ "value": "workspace-key", "origins": ["https://api.acme.com"], "runnerCanUse": false }));
    assert!(s["BROKEN"]["refused"].as_str().unwrap().contains("can't be opened"));

    // No secrets at all yet: they're added.
    let mut bare = json!({ "runId": "r" });
    merge(&mut bare, open_for_engine(&k, WS, &[eref("PW", ID, &pw.value)]));
    assert_eq!(bare["secrets"]["PW"]["value"], "from-workspace");
}

#[test]
fn the_scope_is_taken_out_of_any_request() {
    let mut p = json!({ "url": "https://a.acme.com", "workspace": "bad|id", "workspaceSecrets": "nonsense" });
    let scope = take_scope(&mut p);
    assert!(scope.workspace.is_none() && scope.refs.is_empty());
    assert_eq!(p, json!({ "url": "https://a.acme.com" }));
    let mut not_an_object = json!(null);
    assert!(take_scope(&mut not_an_object).workspace.is_none());
    let mut padded = json!({ "workspace": " team:acme/breakpatch" });
    assert!(take_scope(&mut padded).workspace.is_none(), "an id is taken as it is, never trimmed into another");
}

// ---- The format, pinned (testdata/workspace-secret-v1.json; the Team engine opens the same) ----

fn seq<const N: usize>(start: u8) -> [u8; N] {
    std::array::from_fn(|i| start.wrapping_add(i as u8))
}

fn make_vector() -> Value {
    let data_key: [u8; 32] = seq(0x80);
    let payload = Payload {
        v: 1,
        name: "ACME_PASSWORD".into(),
        value: "hunter2 ü".into(),
        origins: vec!["https://app.acme.example".into()],
        runner_can_use: true,
        ci_can_use: false,
    };
    let json_text = serde_json::to_string(&payload).unwrap();
    let path = format!("secrets/{ID}");
    let enc = seal_field_with(&data_key, WS, &path, VALUE_FIELD, 3, seq(0x20), json_text.as_bytes()).unwrap();
    let info = Info { name: "ACME_PASSWORD".into(), origins: vec!["https://app.acme.example".into()], runner_can_use: true, ci_can_use: false };
    let info_text = serde_json::to_string(&info).unwrap();
    let info_enc = seal_field_with(&data_key, WS, &path, INFO_FIELD, 3, seq(0x50), info_text.as_bytes()).unwrap();
    json!({
        "ws": WS, "id": ID, "path": path, "kid": 3,
        "dataKey": data_key.iter().map(|b| format!("{b:02x}")).collect::<String>(),
        "value": { "json": json_text, "enc": enc },
        "info": { "json": info_text, "enc": info_enc },
    })
}

/// `BP_WRITE_VECTORS=1 cargo test --lib workspace_secrets` writes the file again (only when the format changes).
#[test]
fn the_format_is_pinned_and_opens_on_a_mac_holding_the_key() {
    let made = make_vector();
    if std::env::var("BP_WRITE_VECTORS").as_deref() == Ok("1") {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/workspace-secret-v1.json");
        std::fs::write(path, serde_json::to_string_pretty(&made).unwrap() + "\n").unwrap();
    }
    let pinned: Value = serde_json::from_str(include_str!("testdata/workspace-secret-v1.json")).unwrap();
    assert_eq!(made, pinned);
    // A Mac whose Keychain holds that key version opens it for the engine.
    let store = MemStore::default();
    let key_b64 = STANDARD.encode(seq::<32>(0x80));
    store.set(&format!("people:{WS}"), &json!({ "v": 2, "keys": { "3": key_b64 } }).to_string()).unwrap();
    let k = WorkspaceKeys::new(store);
    let got = open_for_engine(&k, WS, &[EngineRef { name: "ACME_PASSWORD".into(), id: ID.into(), enc: pinned["value"]["enc"].as_str().unwrap().into(), kid: 3 }]);
    assert_eq!(got[0].1.as_ref().unwrap(), &json!({ "value": "hunter2 ü", "origins": ["https://app.acme.example"], "runnerCanUse": true }));
}

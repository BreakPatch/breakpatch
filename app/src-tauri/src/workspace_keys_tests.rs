use super::*;
use serde_json::{json, Value};
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

fn mac() -> WorkspaceKeys<MemStore> {
    WorkspaceKeys::new(MemStore::default())
}

const WS: &str = "team:acme-tests/breakpatch";

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn unhex<const N: usize>(s: &str) -> [u8; N] {
    let v: Vec<u8> = (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect();
    v.try_into().unwrap()
}
fn seq<const N: usize>(start: u8) -> [u8; N] {
    std::array::from_fn(|i| start.wrapping_add(i as u8))
}

fn item(path: &str, field: &str, value: &str) -> SealItem {
    SealItem { path: path.into(), field: field.into(), value: value.into() }
}
fn open_item(path: &str, field: &str, b: &Blob) -> OpenItem {
    OpenItem { path: path.into(), field: field.into(), enc: b.enc.clone(), kid: b.kid }
}

// ---- Test vectors (testdata/workspace-keys-v1.json; the Team engine checks the same file) ----

/// The vectors as this code makes them from fixed inputs.
fn make_vectors() -> Value {
    let data_key: [u8; 32] = seq(0x80);
    let field_json = r#"[{"id":"s1","action":"type","target":{"label":"Email"},"text":"ana@acme.example"}]"#;
    let enc = seal_field_with(&data_key, WS, "apps/web/tests/login/versions/3", "steps", 2, seq(0x40), field_json.as_bytes()).unwrap();
    let name_enc = seal_field_with(&data_key, "hosted:w_7Kq2", "apps/web/tests/login", "name", 1, seq(0x10), r#""Log in (café)""#.as_bytes()).unwrap();

    let recipient_secret: [u8; 32] = seq(0x20);
    let recipient_pk = PublicKey::from(&StaticSecret::from(recipient_secret)).to_bytes();
    let id = device_id(&recipient_pk);
    let sealed = seal_to_with(&recipient_pk, seq(0x60), seq(0x30), WS, &id, 2, &data_key).unwrap();

    let code: [u8; 16] = seq(0xa0);
    let rec = recovery_secret(&code, WS);
    let rec_sealed = seal_to_with(&PublicKey::from(&rec).to_bytes(), seq(0x61), seq(0x31), WS, "recovery", 1, &data_key).unwrap();

    let machine: [u8; 32] = seq(0xc0);
    let mac_secret = machine_secret(&machine, WS);
    let mac_sealed = seal_to_with(&PublicKey::from(&mac_secret).to_bytes(), seq(0x62), seq(0x32), WS, "machine", 1, &data_key).unwrap();

    json!({
        "v": 1,
        "note": "Workspace keys test vectors (app/src-tauri/src/workspace_keys.rs). The Team engine's content_keys.py and its tests read the same. Hex unless it says b64.",
        "fields": [
            {"dataKey": hex(&data_key), "ws": WS, "path": "apps/web/tests/login/versions/3", "field": "steps", "kid": 2,
             "nonce": hex(&seq::<24>(0x40)), "json": field_json, "enc_b64": enc,
             "ad": field_ad(WS, "apps/web/tests/login/versions/3", "steps", 2)},
            {"dataKey": hex(&data_key), "ws": "hosted:w_7Kq2", "path": "apps/web/tests/login", "field": "name", "kid": 1,
             "nonce": hex(&seq::<24>(0x10)), "json": r#""Log in (café)""#, "enc_b64": name_enc,
             "ad": field_ad("hosted:w_7Kq2", "apps/web/tests/login", "name", 1)},
        ],
        "seal": {"recipientSecret": hex(&recipient_secret), "recipientPublic_b64": STANDARD.encode(recipient_pk), "deviceId": id,
                 "fingerprint": fingerprint(&recipient_pk), "eph": hex(&seq::<32>(0x60)), "nonce": hex(&seq::<24>(0x30)),
                 "ws": WS, "kid": 2, "key": hex(&data_key), "sealed": sealed},
        "recovery": {"code": hex(&code), "text": recovery_code_text(&code), "ws": WS, "public_b64": public_of(&rec),
                     "sealed": rec_sealed, "key": hex(&data_key)},
        "machine": {"key": hex(&machine), "text": machine_key_text(&machine), "ws": WS, "public_b64": public_of(&mac_secret),
                    "sealed": mac_sealed, "dataKey": hex(&data_key)},
    })
}

const VECTORS: &str = include_str!("testdata/workspace-keys-v1.json");

/// `BP_WRITE_VECTORS=1 cargo test --lib workspace_keys` writes the file again (only when the format changes).
#[test]
fn the_test_vectors_are_what_this_code_makes() {
    let made = make_vectors();
    if std::env::var("BP_WRITE_VECTORS").as_deref() == Ok("1") {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/src/testdata/workspace-keys-v1.json");
        std::fs::write(path, serde_json::to_string_pretty(&made).unwrap() + "\n").unwrap();
    }
    let pinned: Value = serde_json::from_str(VECTORS).unwrap();
    assert_eq!(made, pinned);
}

#[test]
fn the_pinned_vectors_open() {
    let v: Value = serde_json::from_str(VECTORS).unwrap();
    for f in v["fields"].as_array().unwrap() {
        let key: [u8; 32] = unhex(f["dataKey"].as_str().unwrap());
        let json = open_field(&key, f["ws"].as_str().unwrap(), f["path"].as_str().unwrap(), f["field"].as_str().unwrap(),
            f["kid"].as_u64().unwrap() as u32, f["enc_b64"].as_str().unwrap()).unwrap();
        assert_eq!(String::from_utf8(json).unwrap(), f["json"].as_str().unwrap());
    }
    let s = &v["seal"];
    let secret = StaticSecret::from(unhex::<32>(s["recipientSecret"].as_str().unwrap()));
    let sealed: Sealed = serde_json::from_value(s["sealed"].clone()).unwrap();
    let key = open_sealed(&secret, WS, s["deviceId"].as_str().unwrap(), &sealed).unwrap();
    assert_eq!(hex(&key[..]), s["key"].as_str().unwrap());

    let r = &v["recovery"];
    let code = parse_recovery_code(r["text"].as_str().unwrap()).unwrap();
    assert_eq!(hex(&code), r["code"].as_str().unwrap());
    let sealed: Sealed = serde_json::from_value(r["sealed"].clone()).unwrap();
    assert_eq!(hex(&open_sealed(&recovery_secret(&code, WS), WS, "recovery", &sealed).unwrap()[..]), r["key"].as_str().unwrap());

    let m = &v["machine"];
    let mk = parse_machine_key(m["text"].as_str().unwrap()).unwrap();
    let sealed: Sealed = serde_json::from_value(m["sealed"].clone()).unwrap();
    assert_eq!(hex(&open_sealed(&machine_secret(&mk, WS), WS, "machine", &sealed).unwrap()[..]), m["dataKey"].as_str().unwrap());
}

// ---- Fields ----------------------------------------------------------------------------------

#[test]
fn a_field_opens_only_in_its_own_place() {
    let key: [u8; 32] = seq(1);
    let enc = seal_field(&key, WS, "apps/a/tests/t", "name", 1, br#""Checkout""#).unwrap();
    assert_eq!(open_field(&key, WS, "apps/a/tests/t", "name", 1, &enc).unwrap(), br#""Checkout""#);
    // Another document, field, key version, workspace or key: refused.
    assert!(open_field(&key, WS, "apps/a/tests/u", "name", 1, &enc).is_err());
    assert!(open_field(&key, WS, "apps/a/tests/t", "description", 1, &enc).is_err());
    assert!(open_field(&key, WS, "apps/a/tests/t", "name", 2, &enc).is_err());
    assert!(open_field(&key, "team:other/breakpatch", "apps/a/tests/t", "name", 1, &enc).is_err());
    assert!(open_field(&seq(2), WS, "apps/a/tests/t", "name", 1, &enc).is_err());
    // A changed byte: refused.
    let mut raw = STANDARD.decode(&enc).unwrap();
    raw[30] ^= 1;
    assert!(open_field(&key, WS, "apps/a/tests/t", "name", 1, &STANDARD.encode(raw)).is_err());
    assert!(open_field(&key, WS, "apps/a/tests/t", "name", 1, "c2hvcnQ=").is_err());
}

#[test]
fn each_seal_uses_a_new_nonce() {
    let key: [u8; 32] = seq(1);
    let a = seal_field(&key, WS, "apps/a", "name", 1, b"\"x\"").unwrap();
    let b = seal_field(&key, WS, "apps/a", "name", 1, b"\"x\"").unwrap();
    assert_ne!(a, b);
}

#[test]
fn names_with_the_separator_and_huge_fields_are_refused() {
    let key: [u8; 32] = seq(1);
    assert!(seal_field(&key, "team:a|b", "apps/a", "name", 1, b"1").is_err());
    assert!(seal_field(&key, WS, "apps/a", "na|me", 1, b"1").is_err());
    assert!(seal_field(&key, WS, "", "name", 1, b"1").is_err());
    let big = vec![b'a'; MAX_FIELD_BYTES + 1];
    assert!(seal_field(&key, WS, "apps/a", "steps", 1, &big).unwrap_err().contains("too big"));
}

// ---- The recovery code -----------------------------------------------------------------------

#[test]
fn the_recovery_code_reads_back_however_it_is_typed() {
    let code: [u8; 16] = seq(0xa0);
    let text = recovery_code_text(&code);
    assert!(text.starts_with("BPR1-"));
    assert_eq!(text.len(), "BPR1-".len() + 27 + 6);
    assert_eq!(text.split('-').skip(1).map(str::len).collect::<Vec<_>>(), vec![4, 4, 4, 4, 4, 4, 3]);
    assert_eq!(parse_recovery_code(&text).unwrap(), code);
    assert_eq!(parse_recovery_code(&text.to_lowercase()).unwrap(), code);
    assert_eq!(parse_recovery_code(&format!("  {} ", text.replace('-', " "))).unwrap(), code);
    // O for 0 and I or L for 1, as Crockford base32 allows.
    let loose = text[5..].replace('0', "O").replace('1', "l");
    assert_eq!(parse_recovery_code(&format!("BPR1-{loose}")).unwrap(), code);
    for c in [[0u8; 16], [0xff; 16]] {
        assert_eq!(parse_recovery_code(&recovery_code_text(&c)).unwrap(), c);
    }
}

#[test]
fn a_typo_in_the_recovery_code_is_caught() {
    let text = recovery_code_text(&seq(0xa0));
    let mut chars: Vec<char> = text.chars().collect();
    let mut caught = 0;
    for pos in [6, 12, 20, 30] {
        let orig = chars[pos];
        chars[pos] = if orig == 'X' { 'Y' } else { 'X' };
        if parse_recovery_code(&chars.iter().collect::<String>()).is_err() {
            caught += 1;
        }
        chars[pos] = orig;
    }
    assert!(caught >= 3, "most single typos are caught ({caught} of 4)");
    assert!(parse_recovery_code("BPR1-1234").is_err());
    assert!(parse_recovery_code("bpmk1_abc").is_err());
    assert!(parse_recovery_code(&text.replacen("BPR1", "BPR2", 1)).is_err());
}

// ---- Two Macs, a recovery code, the machine key ---------------------------------------------

#[test]
fn the_first_mac_makes_the_key_and_new_versions_keep_old_content_readable() {
    let a = mac();
    assert_eq!(a.status(WS).unwrap(), Status { has_key: false, current: None, kids: vec![] });
    assert!(a.seal(WS, None, &[item("apps/a", "name", "\"Web\"")]).is_err());
    assert_eq!(a.create(WS, None).unwrap(), 1);
    assert!(a.create(WS, None).is_err(), "never replaced");
    // Every copy lost: a new Mac starts again with the next version.
    assert_eq!(mac().create(WS, Some(3)).unwrap(), 3);
    let old = a.seal(WS, None, &[item("apps/a", "name", "\"Web\"")]).unwrap();
    assert_eq!(old[0].kid, 1);
    assert_eq!(a.rotate(WS).unwrap(), 2);
    let new = a.seal(WS, None, &[item("apps/a", "name", "\"Web 2\"")]).unwrap();
    assert_eq!(new[0].kid, 2);
    let pinned = a.seal(WS, Some(1), &[item("apps/a", "name", "\"Web 1\"")]).unwrap();
    assert_eq!(pinned[0].kid, 1);
    let opened = a.open(WS, &[open_item("apps/a", "name", &old[0]), open_item("apps/a", "name", &new[0]), open_item("apps/b", "name", &new[0])]).unwrap();
    assert_eq!(opened, vec![Some("\"Web\"".into()), Some("\"Web 2\"".into()), None]);
    assert_eq!(a.status(WS).unwrap(), Status { has_key: true, current: Some(2), kids: vec![1, 2] });
    // Kept in the Keychain entry people:<ws>, read back by the next launch.
    let text = a.store.get(&format!("people:{WS}")).unwrap().unwrap();
    let b = WorkspaceKeys::new(MemStore::default());
    b.store.set(&format!("people:{WS}"), &text).unwrap();
    assert_eq!(b.open(WS, &[open_item("apps/a", "name", &old[0])]).unwrap(), vec![Some("\"Web\"".into())]);
}

#[test]
fn old_key_versions_go_once_everything_is_sealed_with_the_new_one() {
    let a = mac();
    assert!(a.retire(WS, 1).is_err(), "no key yet");
    a.create(WS, None).unwrap();
    let old = a.seal(WS, None, &[item("apps/a", "name", "\"Web\"")]).unwrap();
    assert_eq!(a.rotate(WS).unwrap(), 2);
    assert_eq!(a.rotate(WS).unwrap(), 3);
    assert!(a.retire(WS, 4).is_err(), "never left without the key it keeps");
    assert_eq!(a.retire(WS, 3).unwrap(), vec![3]);
    assert_eq!(a.status(WS).unwrap(), Status { has_key: true, current: Some(3), kids: vec![3] });
    assert_eq!(a.open(WS, &[open_item("apps/a", "name", &old[0])]).unwrap(), vec![None], "content sealed with key 1 no longer opens here");
    // Kept so in the Keychain.
    let text = a.store.get(&format!("people:{WS}")).unwrap().unwrap();
    let b = WorkspaceKeys::new(MemStore::default());
    b.store.set(&format!("people:{WS}"), &text).unwrap();
    assert_eq!(b.status(WS).unwrap().kids, vec![3]);
    assert_eq!(a.retire(WS, 3).unwrap(), vec![3], "again: nothing to drop");
}

#[test]
fn an_admin_approves_a_new_mac_by_sealing_the_key_to_it() {
    let admin = mac();
    admin.create(WS, None).unwrap();
    admin.rotate(WS).unwrap();
    let ana = mac();
    let dev = ana.device(WS).unwrap();
    assert_eq!(ana.device(WS).unwrap(), dev, "the same pair every time");
    assert_eq!(dev.fingerprint.split(' ').count(), 4);
    assert_eq!(dev.id.len(), 16);
    // The grant is for that device only.
    assert!(admin.grant(WS, "0000000000000000", &dev.public_key).is_err());
    let grants = admin.grant(WS, &dev.id, &dev.public_key).unwrap();
    assert_eq!(grants.iter().map(|g| g.kid).collect::<Vec<_>>(), vec![1, 2]);
    // Someone else's Mac can't take it.
    assert!(mac().accept(WS, &grants).is_err());
    assert_eq!(ana.accept(WS, &grants).unwrap(), vec![1, 2]);
    let b = admin.seal(WS, None, &[item("apps/a/tests/t", "name", "\"Login\"")]).unwrap();
    assert_eq!(ana.open(WS, &[open_item("apps/a/tests/t", "name", &b[0])]).unwrap(), vec![Some("\"Login\"".into())]);
    // Another workspace's grant doesn't open here.
    assert!(ana.accept("team:other/breakpatch", &grants).is_err());
}

#[test]
fn the_recovery_code_brings_the_key_back_and_a_new_code_cancels_the_old() {
    let admin = mac();
    admin.create(WS, None).unwrap();
    let lock = admin.recovery_new(WS).unwrap();
    assert_eq!(admin.pending_code(WS).unwrap().as_str(), lock.secret);
    assert!(admin.pending_code("team:other/breakpatch").is_none());
    admin.forget_pending();
    assert!(admin.pending_code(WS).is_none());
    let content = admin.seal(WS, None, &[item("suites/smoke", "name", "\"Smoke\"")]).unwrap();

    // Every Mac lost: a new Mac and the code.
    let fresh = mac();
    assert!(fresh.recover(WS, "BPR1-0000-0000-0000-0000-0000-0000-000", &lock.public_key, &lock.sealed).is_err());
    assert_eq!(fresh.recover(WS, &lock.secret.to_lowercase(), &lock.public_key, &lock.sealed).unwrap(), vec![1]);
    assert_eq!(fresh.open(WS, &[open_item("suites/smoke", "name", &content[0])]).unwrap(), vec![Some("\"Smoke\"".into())]);

    // A new key version: any admin's Mac re-locks the same copy without the code.
    admin.rotate(WS).unwrap();
    let relocked = admin.grant(WS, "recovery", &lock.public_key).unwrap();
    let later = mac();
    assert_eq!(later.recover(WS, &lock.secret, &lock.public_key, &relocked).unwrap(), vec![1, 2]);

    // Regenerated: the old code no longer matches the workspace's copy.
    let next = admin.recovery_new(WS).unwrap();
    assert_ne!(next.public_key, lock.public_key);
    let err = mac().recover(WS, &lock.secret, &next.public_key, &next.sealed).unwrap_err();
    assert!(err.contains("newer one"), "{err}");
    // Nor in another workspace.
    assert!(mac().recover("team:other/breakpatch", &next.secret, &next.public_key, &next.sealed).is_err());
}

#[test]
fn the_machine_key_opens_the_workspace_for_the_runner_and_ci() {
    let admin = mac();
    admin.create(WS, None).unwrap();
    let lock = admin.machine_new(WS).unwrap();
    assert!(lock.secret.starts_with("bpmk1_"));
    let runner = mac();
    assert!(runner.machine_use(WS, "bpmk1_nope", &lock.public_key, &lock.sealed).is_err());
    assert_eq!(runner.machine_use(WS, &lock.secret, &lock.public_key, &lock.sealed).unwrap(), vec![1]);
    // A recovery copy isn't a machine copy.
    let rec = admin.recovery_new(WS).unwrap();
    assert!(mac().machine_use(WS, &lock.secret, &lock.public_key, &rec.sealed).is_err());
}

#[test]
fn the_invite_link_carries_the_key_for_its_own_workspace_only() {
    let admin = mac();
    assert!(admin.invite(WS).is_err());
    admin.create(WS, None).unwrap();
    admin.rotate(WS).unwrap();
    let bundle = admin.invite(WS).unwrap();
    assert!(bundle.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "URL-safe");
    let ana = mac();
    assert!(ana.import_invite("team:other/breakpatch", &bundle).unwrap_err().contains("another workspace"));
    assert!(ana.import_invite(WS, "not-a-bundle").is_err());
    assert_eq!(ana.import_invite(WS, &bundle).unwrap(), vec![1, 2]);
    assert_eq!(ana.import_invite(WS, &bundle).unwrap(), vec![1, 2], "twice is fine");
    // A Mac holding another key 1 keeps it.
    let other = mac();
    other.create(WS, None).unwrap();
    assert!(other.import_invite(WS, &bundle).unwrap_err().contains("already holds another key"));
    ana.forget(WS).unwrap();
    assert!(!ana.status(WS).unwrap().has_key);
}

#[test]
fn a_damaged_keychain_entry_says_so() {
    let a = mac();
    a.store.set(&format!("people:{WS}"), "{not json").unwrap();
    assert!(a.status(WS).unwrap_err().contains("damaged"));
    assert!(mac().status("bad|ws").is_err());
}

// ---- The recovery kit ------------------------------------------------------------------------

#[test]
fn the_recovery_kit_is_a_one_page_pdf_with_the_code() {
    let code = recovery_code_text(&seq(0xa0));
    let pdf = recovery_kit_pdf("Acme (QA) café", &code, "2026-09-30");
    let text = String::from_utf8_lossy(&pdf).into_owned();
    assert!(text.starts_with("%PDF-1.4\n"));
    assert!(text.ends_with("%%EOF\n"));
    assert!(text.contains(&code));
    assert!(text.contains("Acme \\(QA\\) caf\\351"));
    assert!(text.contains("/Count 1"));
    // The cross-reference table points at each object.
    let start: usize = text.rsplit("startxref\n").next().unwrap().lines().next().unwrap().parse().unwrap();
    assert!(text[start..].starts_with("xref\n"));
    for (i, line) in text[start..].lines().skip(3).take(7).enumerate() {
        let off: usize = line[..10].parse().unwrap();
        assert!(text[off..].starts_with(&format!("{} 0 obj", i + 1)), "object {}", i + 1);
    }
}

#[test]
fn dates_for_the_kit() {
    assert_eq!(ymd(0), "1970-01-01");
    assert_eq!(ymd(1_790_726_400), "2026-09-30");
    assert_eq!(ymd(951_782_400), "2000-02-29");
}

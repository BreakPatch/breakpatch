use super::*;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

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

    // The admin's Mac that signs, and another admin it endorses.
    let admin_seed: [u8; 32] = seq(0x70);
    let admin = signer_public(&admin_seed);
    let other_seed: [u8; 32] = seq(0x90);
    let other = signer_public(&other_seed);
    let sign = |recipient: &str, mut s: Sealed| {
        s.by = admin.clone();
        s.sig = sign_with(&admin_seed, &sealed_msg(WS, recipient, &s));
        s
    };
    let announce = |kid: u32| {
        let check = key_check(&data_key, WS, kid);
        json!({"check": check, "by": admin, "sig": sign_with(&admin_seed, &key_msg(WS, kid, &check))})
    };

    let recipient_secret: [u8; 32] = seq(0x20);
    let recipient_pk = PublicKey::from(&StaticSecret::from(recipient_secret)).to_bytes();
    let recipient_sign: [u8; 32] = seq(0x71);
    let recipient_sign_pk = SigningKey::from_bytes(&recipient_sign).verifying_key().to_bytes();
    let id = device_id(&recipient_pk);
    let sealed = sign(&id, seal_to_with(&recipient_pk, seq(0x60), seq(0x30), WS, &id, 2, &data_key).unwrap());

    let code: [u8; 16] = seq(0xa0);
    let rec = recovery_secret(&code, WS);
    let rec_sealed = sign("recovery", seal_to_with(&PublicKey::from(&rec).to_bytes(), seq(0x61), seq(0x31), WS, "recovery", 1, &data_key).unwrap());

    let machine: [u8; 32] = seq(0xc0);
    let mac_secret = machine_secret(&machine, WS);
    // The machine copy signed by the endorsed admin: CI follows the endorsement from the admin vouched for.
    let mut mac_sealed = seal_to_with(&PublicKey::from(&mac_secret).to_bytes(), seq(0x62), seq(0x32), WS, "machine", 1, &data_key).unwrap();
    mac_sealed.by = other.clone();
    mac_sealed.sig = sign_with(&other_seed, &sealed_msg(WS, "machine", &mac_sealed));
    let endorsement = json!({"pk": other, "by": admin, "sig": sign_with(&admin_seed, &signer_msg(WS, &other))});
    // The first admin withdraws the other's signing key, keeping its own.
    let keep = vec![admin.clone()];
    let revocation = json!({"pk": other, "keep": keep, "by": admin, "sig": sign_with(&admin_seed, &revoke_msg(WS, &other, &keep))});

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
        "sign": {"adminSeed": hex(&admin_seed), "admin_b64": admin, "otherSeed": hex(&other_seed), "other_b64": other,
                 "ws": WS, "dataKey": hex(&data_key),
                 "checks": {"1": announce(1), "2": announce(2)},
                 "check1_b64": key_check(&data_key, WS, 1), "keyMsg1": key_msg(WS, 1, &key_check(&data_key, WS, 1)),
                 "endorsement": endorsement, "signerMsg": signer_msg(WS, &other),
                 "revocation": revocation, "revokeMsg": revoke_msg(WS, &other, &keep),
                 "holds_b64": STANDARD.encode(holds_mac(&data_key, WS, &id, &STANDARD.encode(recipient_sign_pk))),
                 "holdsDevice": id, "holdsSignKey_b64": STANDARD.encode(recipient_sign_pk)},
        "seal": {"recipientSecret": hex(&recipient_secret), "recipientPublic_b64": STANDARD.encode(recipient_pk), "deviceId": id,
                 "recipientSignSeed": hex(&recipient_sign), "fingerprint": fingerprint(&recipient_pk, &recipient_sign_pk),
                 "eph": hex(&seq::<32>(0x60)), "nonce": hex(&seq::<24>(0x30)),
                 "ws": WS, "kid": 2, "key": hex(&data_key), "sealed": sealed, "sealedMsg": sealed_msg(WS, &id, &sealed)},
        "recovery": {"code": hex(&code), "text": recovery_code_text(&code), "ws": WS, "public_b64": public_of(&rec),
                     "sealed": rec_sealed, "key": hex(&data_key),
                     "vouch": {"by": admin, "mac": STANDARD.encode(vouch_mac(&code, WS, "recovery", &admin))}},
        "machine": {"key": hex(&machine), "text": machine_key_text(&machine), "ws": WS, "public_b64": public_of(&mac_secret),
                    "sealed": mac_sealed, "dataKey": hex(&data_key),
                    "vouch": {"by": admin, "mac": STANDARD.encode(vouch_mac(&machine, WS, "machine", &admin))}},
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

fn trust_of(v: &Value) -> Trust {
    let sg = &v["sign"];
    Trust { checks: serde_json::from_value(sg["checks"].clone()).unwrap(), signers: vec![serde_json::from_value(sg["endorsement"].clone()).unwrap()], revoked: vec![] }
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
    let trust = trust_of(&v);
    let admin = v["sign"]["admin_b64"].as_str().unwrap().to_string();
    let trusted = trust.trusted_from(WS, [admin.clone()].into());
    assert!(trusted.contains(v["sign"]["other_b64"].as_str().unwrap()), "the endorsement is followed");

    let s = &v["seal"];
    let secret = StaticSecret::from(unhex::<32>(s["recipientSecret"].as_str().unwrap()));
    let sealed: Sealed = serde_json::from_value(s["sealed"].clone()).unwrap();
    check_sealed(WS, s["deviceId"].as_str().unwrap(), &trusted, &sealed).unwrap();
    let key = open_sealed(&secret, WS, s["deviceId"].as_str().unwrap(), &sealed).unwrap();
    assert_eq!(hex(&key[..]), s["key"].as_str().unwrap());
    trust.check_key(WS, &trusted, 2, &key).unwrap();

    let r = &v["recovery"];
    let code = parse_recovery_code(r["text"].as_str().unwrap()).unwrap();
    assert_eq!(hex(&code), r["code"].as_str().unwrap());
    let vouch: Vouch = serde_json::from_value(r["vouch"].clone()).unwrap();
    assert_eq!(WorkspaceKeys::<MemStore>::vouched(WS, "recovery", &code, &vouch).unwrap(), admin);
    let sealed: Sealed = serde_json::from_value(r["sealed"].clone()).unwrap();
    check_sealed(WS, "recovery", &trusted, &sealed).unwrap();
    assert_eq!(hex(&open_sealed(&recovery_secret(&code, WS), WS, "recovery", &sealed).unwrap()[..]), r["key"].as_str().unwrap());

    let m = &v["machine"];
    let mk = parse_machine_key(m["text"].as_str().unwrap()).unwrap();
    let sealed: Sealed = serde_json::from_value(m["sealed"].clone()).unwrap();
    check_sealed(WS, "machine", &trusted, &sealed).unwrap();
    assert!(check_sealed(WS, "machine", &[admin.clone()].into(), &sealed).is_err(), "not without the endorsement");
    // The revocation: the other admin isn't trusted once it's applied, and the first is kept.
    let mut revoked = trust.clone();
    revoked.revoked.push(serde_json::from_value(v["sign"]["revocation"].clone()).unwrap());
    let res = revoked.resolve(WS, [admin.clone()].into(), BTreeSet::new());
    assert_eq!(res.trusted, [admin.clone()].into());
    assert_eq!(res.revoked, [v["sign"]["other_b64"].as_str().unwrap().to_string()].into());
    assert!(check_sealed(WS, "machine", &res.trusted, &sealed).is_err(), "the withdrawn admin's copy is refused");
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
    // The other secrets' shapes say what they are.
    assert!(parse_recovery_code(&format!("BPM1-{}-{}", "0".repeat(32), "1".repeat(64))).unwrap_err().contains("machine pass"));
    let token = |p: &str| format!("{p}-{}-{}-{}", "k".repeat(28), "m".repeat(16), "c".repeat(64));
    assert!(parse_recovery_code(&token("BPC1")).unwrap_err().starts_with("That's a CI token (BPC1-…), not the recovery code"));
    assert!(parse_recovery_code(&token("BPM1")).unwrap_err().starts_with("That's a runner token (BPM1-…), not the recovery code"));
    assert!(parse_recovery_code("BP-2HC6-FWG8-CR0K-VBDB").unwrap_err().contains("licence key"));
    assert!(parse_recovery_code("bpmk1_abc").unwrap_err().contains("machine key"));
    assert!(parse_recovery_code(&text.replacen("BPR1", "BPR2", 1)).is_err());
}

// ---- Two Macs, a recovery code, the machine key ---------------------------------------------

/// What the workspace's documents say about its keys: keys/meta.checks and keys/signers.
#[derive(Default, Clone)]
struct Docs(Trust);
impl Docs {
    fn announce(&mut self, a: Announced) -> u32 {
        self.0.checks.insert(a.kid.to_string(), a.check);
        a.kid
    }
    fn endorse(&mut self, e: Endorsement) {
        self.0.signers.push(e);
    }
    fn revoke(&mut self, r: Revocation) {
        self.0.revoked.push(r);
    }
}

fn signer(m: &WorkspaceKeys<MemStore>) -> String {
    m.device(WS).unwrap().sign_key
}

/// The first admin's Mac with keys 1 and 2, as announced in the workspace.
fn admin_with_two_keys() -> (WorkspaceKeys<MemStore>, Docs) {
    let admin = mac();
    let mut docs = Docs::default();
    docs.announce(admin.create(WS, None).unwrap());
    docs.announce(admin.rotate(WS).unwrap());
    (admin, docs)
}

#[test]
fn the_first_mac_makes_the_key_and_new_versions_keep_old_content_readable() {
    let a = mac();
    assert_eq!(a.status(WS).unwrap(), Status { has_key: false, current: None, kids: vec![], pinned: false, withdrawn: false });
    assert!(a.seal(WS, None, &[item("apps/a", "name", "\"Web\"")]).is_err());
    let first = a.create(WS, None).unwrap();
    assert_eq!(first.kid, 1);
    assert_eq!(first.check.by, signer(&a), "announced by this Mac");
    assert!(a.create(WS, None).is_err(), "never replaced");
    // Every copy lost: a new Mac starts again with the next version.
    assert_eq!(mac().create(WS, Some(3)).unwrap().kid, 3);
    let old = a.seal(WS, None, &[item("apps/a", "name", "\"Web\"")]).unwrap();
    assert_eq!(old[0].kid, 1);
    assert_eq!(a.rotate(WS).unwrap().kid, 2);
    let new = a.seal(WS, None, &[item("apps/a", "name", "\"Web 2\"")]).unwrap();
    assert_eq!(new[0].kid, 2);
    let pinned = a.seal(WS, Some(1), &[item("apps/a", "name", "\"Web 1\"")]).unwrap();
    assert_eq!(pinned[0].kid, 1);
    let opened = a.open(WS, &[open_item("apps/a", "name", &old[0]), open_item("apps/a", "name", &new[0]), open_item("apps/b", "name", &new[0])]).unwrap();
    assert_eq!(opened, vec![Some("\"Web\"".into()), Some("\"Web 2\"".into()), None]);
    assert_eq!(a.status(WS).unwrap(), Status { has_key: true, current: Some(2), kids: vec![1, 2], pinned: false, withdrawn: false });
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
    assert_eq!(a.rotate(WS).unwrap().kid, 2);
    assert_eq!(a.rotate(WS).unwrap().kid, 3);
    assert!(a.retire(WS, 4).is_err(), "never left without the key it keeps");
    assert_eq!(a.retire(WS, 3).unwrap(), vec![3]);
    assert_eq!(a.status(WS).unwrap().kids, vec![3]);
    assert_eq!(a.open(WS, &[open_item("apps/a", "name", &old[0])]).unwrap(), vec![None], "content sealed with key 1 no longer opens here");
    // Kept so in the Keychain.
    let text = a.store.get(&format!("people:{WS}")).unwrap().unwrap();
    let b = WorkspaceKeys::new(MemStore::default());
    b.store.set(&format!("people:{WS}"), &text).unwrap();
    assert_eq!(b.status(WS).unwrap().kids, vec![3]);
    assert_eq!(a.retire(WS, 3).unwrap(), vec![3], "again: nothing to drop");
}

#[test]
fn an_admin_approves_a_new_mac_and_it_takes_the_key_once_it_trusts_the_admin() {
    let (admin, docs) = admin_with_two_keys();
    let ana = mac();
    let dev = ana.device(WS).unwrap();
    assert_eq!(ana.device(WS).unwrap(), dev, "the same keys every time");
    assert_eq!(dev.fingerprint.split(' ').count(), 4);
    assert_eq!(dev.id.len(), 16);
    // The grant is for that device only.
    assert!(admin.grant(WS, "0000000000000000", &dev.public_key).is_err());
    let grants = admin.grant(WS, &dev.id, &dev.public_key).unwrap();
    assert_eq!(grants.iter().map(|g| g.kid).collect::<Vec<_>>(), vec![1, 2]);
    assert!(grants.iter().all(|g| g.by == signer(&admin) && !g.sig.is_empty()), "signed by the admin's Mac");
    // A Mac that trusts no admin yet asks its person to check the admin's words first.
    assert!(!ana.signer_trusted(WS, &signer(&admin), &docs.0).unwrap());
    assert!(ana.accept(WS, &grants, &docs.0).unwrap_err().contains("doesn't trust"));
    assert!(!ana.status(WS).unwrap().has_key);
    ana.trust(WS, &signer(&admin)).unwrap();
    assert!(ana.status(WS).unwrap().pinned);
    // Someone else's Mac can't take it.
    let other = mac();
    other.trust(WS, &signer(&admin)).unwrap();
    assert!(other.accept(WS, &grants, &docs.0).is_err());
    assert_eq!(ana.accept(WS, &grants, &docs.0).unwrap(), vec![1, 2]);
    let b = admin.seal(WS, None, &[item("apps/a/tests/t", "name", "\"Login\"")]).unwrap();
    assert_eq!(ana.open(WS, &[open_item("apps/a/tests/t", "name", &b[0])]).unwrap(), vec![Some("\"Login\"".into())]);
    // Another workspace's grant doesn't open here.
    assert!(ana.accept("team:other/breakpatch", &grants, &docs.0).is_err());
}

#[test]
fn a_grant_the_admin_didnt_make_is_refused() {
    let (admin, mut docs) = admin_with_two_keys();
    let ana = mac();
    ana.trust(WS, &signer(&admin)).unwrap();
    let dev = ana.device(WS).unwrap();
    let pk = parse_public(&dev.public_key).unwrap();
    let real = admin.grant(WS, &dev.id, &dev.public_key).unwrap();

    // Whoever can write the workspace seals a key of their own to Ana's device key (it's public)…
    let theirs: [u8; 32] = seq(0x33);
    let unsigned = seal_to(&pk, WS, &dev.id, 3, &theirs).unwrap();
    assert!(ana.accept(WS, std::slice::from_ref(&unsigned), &docs.0).unwrap_err().contains("isn't signed"));
    // …signs it with a Mac of their own, and announces it as key 3.
    let server = mac();
    let s3 = server.device(WS).unwrap().sign_key;
    let mut signed = unsigned.clone();
    signed.by = s3.clone();
    signed.sig = server.device_secrets(WS).unwrap().sign(&sealed_msg(WS, &dev.id, &signed));
    let check = key_check(&theirs, WS, 3);
    docs.0.checks.insert("3".into(), Check { check: check.clone(), by: s3.clone(), sig: server.device_secrets(WS).unwrap().sign(&key_msg(WS, 3, &check)) });
    assert!(ana.accept(WS, &[signed.clone()], &docs.0).unwrap_err().contains("doesn't trust"));
    // An endorsement it made itself doesn't make it trusted.
    docs.endorse(server.endorse(WS, &s3).unwrap());
    assert!(ana.accept(WS, &[signed.clone()], &docs.0).is_err());
    // Claiming to be the admin: the signature doesn't match.
    let mut claimed = signed.clone();
    claimed.by = signer(&admin);
    assert!(ana.accept(WS, &[claimed], &docs.0).unwrap_err().contains("signature"));
    // A changed copy of the admin's grant: the signature doesn't match.
    let mut changed = real[1].clone();
    changed.epk = unsigned.epk.clone();
    assert!(ana.accept(WS, &[changed], &docs.0).is_err());
    // The admin's grant with key 2's announcement replaced: not the key announced.
    let mut swapped = docs.clone();
    swapped.0.checks.insert("2".into(), docs.0.checks["3"].clone());
    assert!(ana.accept(WS, &real, &swapped.0).is_err());
    let mut wrong = docs.clone();
    let c1 = wrong.0.checks["1"].clone();
    wrong.0.checks.insert("2".into(), Check { check: c1.check.clone(), ..wrong.0.checks["2"].clone() });
    assert!(ana.accept(WS, &real, &wrong.0).is_err(), "a check whose signature doesn't cover it");
    // Not announced at all.
    let mut none = docs.clone();
    none.0.checks.remove("2");
    assert!(ana.accept(WS, &real, &none.0).unwrap_err().contains("announced"));
    assert!(!ana.status(WS).unwrap().has_key, "nothing was taken");
    assert_eq!(ana.accept(WS, &real, &docs.0).unwrap(), vec![1, 2]);
}

#[test]
fn an_admin_endorsed_by_a_trusted_one_is_trusted_too() {
    let (first, mut docs) = admin_with_two_keys();
    // A second admin's Mac, let in by the first, which endorses it.
    let second = mac();
    second.trust(WS, &signer(&first)).unwrap();
    let d2 = second.device(WS).unwrap();
    second.accept(WS, &first.grant(WS, &d2.id, &d2.public_key).unwrap(), &docs.0).unwrap();
    let ana = mac();
    ana.trust(WS, &signer(&first)).unwrap();
    let dev = ana.device(WS).unwrap();
    let grants = second.grant(WS, &dev.id, &dev.public_key).unwrap();
    assert!(ana.accept(WS, &grants, &docs.0).is_err(), "not endorsed yet");
    docs.endorse(first.endorse(WS, &d2.sign_key).unwrap());
    assert!(ana.signer_trusted(WS, &d2.sign_key, &docs.0).unwrap());
    // A new key version announced by the second admin is taken too.
    docs.announce(second.rotate(WS).unwrap());
    let grants = second.grant(WS, &dev.id, &dev.public_key).unwrap();
    assert_eq!(ana.accept(WS, &grants, &docs.0).unwrap(), vec![1, 2, 3]);
    // A forged endorsement (the signature isn't the first admin's) isn't followed.
    let mut forged = first.endorse(WS, &signer(&mac())).unwrap();
    forged.pk = signer(&mac());
    assert!(!Docs(Trust { signers: vec![forged.clone()], ..Default::default() }).0.trusted_from(WS, [signer(&first)].into()).contains(&forged.pk));
}

// ---- An admin leaves: their signing key is withdrawn -------------------------------------------

/// The first admin's Mac, a second admin's Mac it let in and endorsed, and Ana's Mac, which pinned
/// the first admin only (an invite link from them) and trusts the second through the endorsement.
fn team_of_two_admins() -> (WorkspaceKeys<MemStore>, WorkspaceKeys<MemStore>, WorkspaceKeys<MemStore>, Docs) {
    let (first, mut docs) = admin_with_two_keys();
    let second = mac();
    second.trust(WS, &signer(&first)).unwrap();
    let d2 = second.device(WS).unwrap();
    second.accept(WS, &first.grant(WS, &d2.id, &d2.public_key).unwrap(), &docs.0).unwrap();
    docs.endorse(first.endorse(WS, &d2.sign_key).unwrap());
    let ana = mac();
    ana.import_invite(WS, &first.invite(WS).unwrap(), &docs.0).unwrap();
    assert!(ana.signer_trusted(WS, &d2.sign_key, &docs.0).unwrap());
    (first, second, ana, docs)
}

#[test]
fn a_withdrawn_admin_is_not_trusted_from_then_on_and_the_others_stay() {
    let (first, second, ana, mut docs) = team_of_two_admins();
    let dev = ana.device(WS).unwrap();
    // A grant the first admin made before leaving, not taken yet.
    let before = first.grant(WS, &dev.id, &dev.public_key).unwrap();
    // The first admin is removed: the second admin's Mac withdraws their key, keeping its own.
    let r = second.revoke(WS, &signer(&first), &[signer(&second), signer(&mac())], &docs.0).unwrap();
    assert_eq!(r.keep, vec![signer(&second)], "only keys it trusts, and its own");
    assert_eq!(r.by, signer(&second));
    docs.revoke(r);
    let review = ana.review(WS, &docs.0).unwrap();
    assert_eq!(review.revoked, vec![signer(&first)]);
    assert!(review.trusted.contains(&signer(&second)), "the admin who's still there stays trusted, though Ana trusted them through the first");
    assert!(!review.withdrawn);
    assert!(ana.status(WS).unwrap().pinned, "the second admin is pinned now");
    // What the first admin signs is refused from now on: copies, announcements, invite links.
    assert!(ana.accept(WS, &before, &docs.0).unwrap_err().contains("doesn't trust"));
    let theirs: [u8; 32] = seq(0x44);
    let first_secrets = first.device_secrets(WS).unwrap();
    let mut forged = seal_to(&parse_public(&dev.public_key).unwrap(), WS, &dev.id, 3, &theirs).unwrap();
    forged.by = signer(&first);
    forged.sig = first_secrets.sign(&sealed_msg(WS, &dev.id, &forged));
    let check = key_check(&theirs, WS, 3);
    let mut pushed = docs.clone();
    pushed.0.checks.insert("3".into(), Check { check: check.clone(), by: signer(&first), sig: first_secrets.sign(&key_msg(WS, 3, &check)) });
    assert!(ana.accept(WS, &[forged], &pushed.0).is_err());
    assert!(!ana.status(WS).unwrap().kids.contains(&3));
    assert!(ana.import_invite(WS, &first.invite(WS).unwrap(), &docs.0).is_err());
    // An announcement the first admin made is refused too, until the second admin signs it again.
    let again = second.grant(WS, &dev.id, &dev.public_key).unwrap();
    assert!(ana.accept(WS, &again, &docs.0).unwrap_err().contains(&*os_text("wasn't announced by an admin this Mac trusts")));
    for kid in [1, 2] {
        docs.announce(second.announce(WS, kid).unwrap());
    }
    assert_eq!(ana.accept(WS, &again, &docs.0).unwrap(), vec![1, 2]);
    // Taking the revocation out of the workspace doesn't bring the first admin back: this Mac keeps it.
    let mut wiped = docs.clone();
    wiped.0.revoked.clear();
    assert!(!ana.signer_trusted(WS, &signer(&first), &wiped.0).unwrap());
    assert!(ana.signer_trusted(WS, &signer(&second), &wiped.0).unwrap());
    let relaunched = WorkspaceKeys::new(MemStore::default());
    for e in ["people", "device"] {
        let n = format!("{e}:{WS}");
        relaunched.store.set(&n, &ana.store.get(&n).unwrap().unwrap()).unwrap();
    }
    assert!(!relaunched.signer_trusted(WS, &signer(&first), &wiped.0).unwrap(), "kept in the Keychain");
    assert!(relaunched.trust(WS, &signer(&first)).unwrap_err().contains("isn't an admin"), "and never pinned again");
}

#[test]
fn a_revocation_counts_only_from_an_admin_this_mac_trusts() {
    let (first, second, ana, mut docs) = team_of_two_admins();
    // Whoever writes the workspace withdraws the admins with a Mac of their own: ignored.
    let server = mac();
    for k in [signer(&first), signer(&second)] {
        let mut r = server.revoke(WS, &k, &[], &docs.0).unwrap();
        docs.revoke(r.clone());
        // Or claims the second admin signed it: the signature doesn't match.
        r.by = signer(&second);
        docs.revoke(r);
    }
    let review = ana.review(WS, &docs.0).unwrap();
    assert!(review.revoked.is_empty());
    assert!(review.trusted.contains(&signer(&first)) && review.trusted.contains(&signer(&second)));
    // A revocation's keep never adds a key: the second admin keeps one it doesn't trust.
    let other = mac();
    let r = second.revoke(WS, &signer(&first), &[signer(&other)], &docs.0).unwrap();
    assert!(!r.keep.contains(&signer(&other)));
    let mut forged = r.clone();
    forged.keep = vec![signer(&other), signer(&second)];
    let mut d = docs.clone();
    d.revoke(forged);
    assert!(ana.review(WS, &d.0).unwrap().revoked.is_empty(), "a changed keep breaks the signature");
    // A Mac can't withdraw its own key.
    assert!(second.revoke(WS, &signer(&second), &[], &docs.0).unwrap_err().contains("its own"));
}

#[test]
fn what_a_withdrawn_admin_endorsed_after_is_not_followed() {
    let (first, second, ana, mut docs) = team_of_two_admins();
    // The first admin's Mac (or whoever has it) endorses a Mac of theirs; then the second admin
    // withdraws the first. A Mac that sees both at once (it was off) trusts the second only.
    let evil = mac();
    docs.endorse(first.endorse(WS, &signer(&evil)).unwrap());
    let r = second.revoke(WS, &signer(&first), &[signer(&second)], &Docs::default().0).unwrap();
    assert_eq!(r.keep, vec![signer(&second)]);
    docs.revoke(r);
    let review = ana.review(WS, &docs.0).unwrap();
    assert!(review.trusted.contains(&signer(&second)));
    assert!(!review.trusted.contains(&signer(&evil)));
    assert!(!review.trusted.contains(&signer(&first)));
}

#[test]
fn two_admins_withdrawing_each_other_both_lose_trust() {
    let (first, second, ana, mut docs) = team_of_two_admins();
    docs.revoke(second.revoke(WS, &signer(&first), &[], &docs.0).unwrap());
    docs.revoke(first.revoke(WS, &signer(&second), &[], &Docs::default().0).unwrap());
    let review = ana.review(WS, &docs.0).unwrap();
    assert_eq!(review.revoked.len(), 2, "refused rather than guessed");
    assert!(!ana.status(WS).unwrap().pinned, "its person checks a remaining admin's words again");
    // A Mac that saw the second admin's revocation first keeps the second admin.
    let (f2, s2, ben, mut d2) = team_of_two_admins();
    d2.revoke(s2.revoke(WS, &signer(&f2), &[signer(&s2)], &d2.0).unwrap());
    ben.review(WS, &d2.0).unwrap();
    d2.revoke(f2.revoke(WS, &signer(&s2), &[], &Docs::default().0).unwrap());
    let later = ben.review(WS, &d2.0).unwrap();
    assert!(later.trusted.contains(&signer(&s2)), "the first admin's key was withdrawn already, so its revocation doesn't count");
}

#[test]
fn a_withdrawn_mac_signs_nothing_and_makes_new_keys_when_its_person_is_an_admin_again() {
    let (first, second, _ana, mut docs) = team_of_two_admins();
    docs.revoke(second.revoke(WS, &signer(&first), &[signer(&second)], &docs.0).unwrap());
    let old = first.device(WS).unwrap();
    assert!(!first.status(WS).unwrap().withdrawn, "not until it sees the revocation");
    assert!(first.renew(WS).is_err(), "nothing to renew yet");
    assert!(first.review(WS, &docs.0).unwrap().withdrawn);
    assert!(first.status(WS).unwrap().withdrawn);
    let ana = mac().device(WS).unwrap();
    for err in [
        first.grant(WS, &ana.id, &ana.public_key).map(|_| ()).unwrap_err(),
        first.announce(WS, 1).map(|_| ()).unwrap_err(),
        first.rotate(WS).map(|_| ()).unwrap_err(),
        first.endorse(WS, &signer(&mac())).map(|_| ()).unwrap_err(),
        first.recovery_new(WS).map(|_| ()).unwrap_err(),
        first.invite(WS).map(|_| ()).unwrap_err(),
        first.revoke(WS, &signer(&second), &[], &docs.0).map(|_| ()).unwrap_err(),
    ] {
        assert!(err.contains("withdrawn"), "{err}");
    }
    assert_eq!(first.status(WS).unwrap().kids, vec![1, 2], "no key version was added by the refused rotate");
    // Made an admin again: new keys, the same key versions, and another admin endorses the new one.
    let new = first.renew(WS).unwrap();
    assert_ne!(new.id, old.id);
    assert_ne!(new.sign_key, old.sign_key);
    assert!(!first.status(WS).unwrap().withdrawn);
    assert_eq!(first.status(WS).unwrap().kids, vec![1, 2]);
    assert!(second.check_proof(WS, &new.id, &new.sign_key, &first.prove(WS).unwrap()).unwrap());
    docs.endorse(second.endorse(WS, &new.sign_key).unwrap());
    let ben = mac();
    ben.trust(WS, &signer(&second)).unwrap();
    assert!(ben.signer_trusted(WS, &new.sign_key, &docs.0).unwrap());
    let relaunched = WorkspaceKeys::new(MemStore::default());
    relaunched.store.set(&format!("device:{WS}"), &first.store.get(&format!("device:{WS}")).unwrap().unwrap()).unwrap();
    assert_eq!(relaunched.device(WS).unwrap(), new, "saved");
}

#[test]
fn a_recovery_code_or_machine_key_a_withdrawn_admin_made_is_refused() {
    let (first, second, _ana, mut docs) = team_of_two_admins();
    let rec = first.recovery_new(WS).unwrap();
    let machine = first.machine_new(WS).unwrap();
    assert_eq!(mac().recover(WS, &rec.secret, &rec.public_key, &rec.sealed, &rec.vouch, &docs.0).unwrap(), vec![1, 2]);
    docs.revoke(second.revoke(WS, &signer(&first), &[signer(&second)], &docs.0).unwrap());
    // They saw the code and the key: neither opens the workspace now, even sealed again by the second admin.
    let relocked = second.grant(WS, "recovery", &rec.public_key).unwrap();
    let err = mac().recover(WS, &rec.secret, &rec.public_key, &relocked, &rec.vouch, &docs.0).unwrap_err();
    assert!(err.contains("recovery code was made by an admin who isn't"), "{err}");
    let err = mac().machine_use(WS, &machine.secret, &machine.public_key, &machine.sealed, &machine.vouch, &docs.0).unwrap_err();
    assert!(err.contains("machine key was made by an admin who isn't"), "{err}");
    // New ones made by the second admin work.
    for kid in [1, 2] {
        docs.announce(second.announce(WS, kid).unwrap());
    }
    let next = second.recovery_new(WS).unwrap();
    assert_eq!(mac().recover(WS, &next.secret, &next.public_key, &next.sealed, &next.vouch, &docs.0).unwrap(), vec![1, 2]);
}

#[test]
fn trust_lists_with_too_many_revocations_are_refused() {
    let k = mac();
    let r = Revocation { pk: signer_public(&seq(3)), keep: vec![], by: signer(&k), sig: String::new() };
    let t = Trust { revoked: vec![r; MAX_SIGNERS + 1], ..Default::default() };
    assert!(k.review(WS, &t).is_err());
}

#[test]
fn a_device_proves_it_holds_the_key() {
    let (admin, docs) = admin_with_two_keys();
    let bundle = admin.invite(WS).unwrap();
    let ana = mac();
    assert!(ana.prove(WS).is_err(), "no key yet");
    ana.import_invite(WS, &bundle, &docs.0).unwrap();
    let dev = ana.device(WS).unwrap();
    let proof = ana.prove(WS).unwrap();
    assert_eq!(proof.kid, 2);
    assert!(admin.check_proof(WS, &dev.id, &dev.sign_key, &proof).unwrap());
    // Not for another device, another signing key, or a made-up MAC; nor on a Mac without that key.
    assert!(!admin.check_proof(WS, "0000000000000000", &dev.sign_key, &proof).unwrap());
    assert!(!admin.check_proof(WS, &dev.id, &signer(&mac()), &proof).unwrap());
    assert!(!admin.check_proof(WS, &dev.id, &dev.sign_key, &Proof { kid: 2, mac: STANDARD.encode([7u8; 32]) }).unwrap());
    assert!(!mac().check_proof(WS, &dev.id, &dev.sign_key, &proof).unwrap());
}

#[test]
fn the_recovery_code_brings_the_key_back_and_a_new_code_cancels_the_old() {
    let admin = mac();
    let mut docs = Docs::default();
    docs.announce(admin.create(WS, None).unwrap());
    let lock = admin.recovery_new(WS).unwrap();
    assert_eq!(lock.vouch.by, signer(&admin));
    assert_eq!(admin.pending_code(WS).unwrap().as_str(), lock.secret);
    assert!(admin.pending_code("team:other/breakpatch").is_none());
    admin.forget_pending();
    assert!(admin.pending_code(WS).is_none());
    let content = admin.seal(WS, None, &[item("suites/smoke", "name", "\"Smoke\"")]).unwrap();

    // Every Mac lost: a new Mac and the code.
    let fresh = mac();
    assert!(fresh.recover(WS, "BPR1-0000-0000-0000-0000-0000-0000-000", &lock.public_key, &lock.sealed, &lock.vouch, &docs.0).is_err());
    assert_eq!(fresh.recover(WS, &lock.secret.to_lowercase(), &lock.public_key, &lock.sealed, &lock.vouch, &docs.0).unwrap(), vec![1]);
    assert_eq!(fresh.open(WS, &[open_item("suites/smoke", "name", &content[0])]).unwrap(), vec![Some("\"Smoke\"".into())]);
    assert!(fresh.signer_trusted(WS, &signer(&admin), &docs.0).unwrap(), "the admin the code vouches for is pinned");

    // A new key version: any admin's Mac re-locks the same copy without the code.
    docs.announce(admin.rotate(WS).unwrap());
    let relocked = admin.grant(WS, "recovery", &lock.public_key).unwrap();
    let later = mac();
    assert_eq!(later.recover(WS, &lock.secret, &lock.public_key, &relocked, &lock.vouch, &docs.0).unwrap(), vec![1, 2]);

    // Regenerated: the old code no longer matches the workspace's copy.
    let next = admin.recovery_new(WS).unwrap();
    assert_ne!(next.public_key, lock.public_key);
    let err = mac().recover(WS, &lock.secret, &next.public_key, &next.sealed, &next.vouch, &docs.0).unwrap_err();
    assert!(err.contains("newer one"), "{err}");
    // Nor in another workspace.
    assert!(mac().recover("team:other/breakpatch", &next.secret, &next.public_key, &next.sealed, &next.vouch, &docs.0).is_err());
}

#[test]
fn a_recovery_or_machine_copy_someone_else_put_there_is_refused() {
    let admin = mac();
    let mut docs = Docs::default();
    docs.announce(admin.create(WS, None).unwrap());
    let rec = admin.recovery_new(WS).unwrap();
    let machine = admin.machine_new(WS).unwrap();
    // Whoever can write the workspace seals their own key to the code's public key, signs it with
    // their own Mac, vouches for that Mac, and announces the key.
    let server = mac();
    let mut sdocs = Docs::default();
    sdocs.announce(server.create(WS, Some(1)).unwrap());
    let theirs = server.grant(WS, "recovery", &rec.public_key).unwrap();
    let their_vouch = Vouch { by: signer(&server), mac: STANDARD.encode([1u8; 32]) };
    let code = rec.secret.clone();
    assert!(mac().recover(WS, &code, &rec.public_key, &theirs, &their_vouch, &sdocs.0).unwrap_err().contains("isn't one an admin made"));
    // The real vouch with their copy: signed by a Mac the vouched admin never endorsed.
    assert!(mac().recover(WS, &code, &rec.public_key, &theirs, &rec.vouch, &sdocs.0).is_err());
    // Their copy unsigned.
    let mut bare = theirs.clone();
    bare.iter_mut().for_each(|s| { s.by.clear(); s.sig.clear(); });
    assert!(mac().recover(WS, &code, &rec.public_key, &bare, &rec.vouch, &docs.0).unwrap_err().contains("isn't signed"));
    // The machine key alike.
    let mtheirs = server.grant(WS, "machine", &machine.public_key).unwrap();
    assert!(mac().machine_use(WS, &machine.secret, &machine.public_key, &mtheirs, &machine.vouch, &sdocs.0).is_err());
    assert!(mac().machine_use(WS, &machine.secret, &machine.public_key, &machine.sealed, &Vouch { by: signer(&server), mac: machine.vouch.mac.clone() }, &docs.0)
        .unwrap_err().contains("isn't one an admin made"));
    // The real ones open.
    assert_eq!(mac().recover(WS, &code, &rec.public_key, &rec.sealed, &rec.vouch, &docs.0).unwrap(), vec![1]);
    assert_eq!(mac().machine_use(WS, &machine.secret, &machine.public_key, &machine.sealed, &machine.vouch, &docs.0).unwrap(), vec![1]);
}

#[test]
fn the_machine_key_opens_the_workspace_for_the_runner_and_ci() {
    let admin = mac();
    let mut docs = Docs::default();
    docs.announce(admin.create(WS, None).unwrap());
    let lock = admin.machine_new(WS).unwrap();
    assert!(lock.secret.starts_with("bpmk1_"));
    let runner = mac();
    assert!(runner.machine_use(WS, "bpmk1_nope", &lock.public_key, &lock.sealed, &lock.vouch, &docs.0).is_err());
    assert_eq!(runner.machine_use(WS, &lock.secret, &lock.public_key, &lock.sealed, &lock.vouch, &docs.0).unwrap(), vec![1]);
    // A recovery copy isn't a machine copy.
    let rec = admin.recovery_new(WS).unwrap();
    assert!(mac().machine_use(WS, &lock.secret, &lock.public_key, &rec.sealed, &lock.vouch, &docs.0).is_err());
}

#[test]
fn the_invite_link_carries_the_key_for_its_own_workspace_only() {
    let admin = mac();
    assert!(admin.invite(WS).is_err());
    let mut docs = Docs::default();
    docs.announce(admin.create(WS, None).unwrap());
    docs.announce(admin.rotate(WS).unwrap());
    let bundle = admin.invite(WS).unwrap();
    assert!(bundle.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'), "URL-safe");
    let ana = mac();
    assert!(ana.import_invite("team:other/breakpatch", &bundle, &docs.0).unwrap_err().contains("another workspace"));
    assert!(ana.import_invite(WS, "not-a-bundle", &docs.0).is_err());
    // Only once the workspace announced those keys.
    assert!(ana.import_invite(WS, &bundle, &Trust::default()).is_err());
    assert_eq!(ana.import_invite(WS, &bundle, &docs.0).unwrap(), vec![1, 2]);
    assert!(ana.signer_trusted(WS, &signer(&admin), &docs.0).unwrap(), "the link's admin is pinned");
    assert_eq!(ana.import_invite(WS, &bundle, &docs.0).unwrap(), vec![1, 2], "twice is fine");
    // A Mac holding another key 1 keeps it.
    let other = mac();
    other.create(WS, None).unwrap();
    assert!(other.import_invite(WS, &bundle, &docs.0).unwrap_err().contains("already holds another key"));
    ana.forget(WS).unwrap();
    assert!(!ana.status(WS).unwrap().has_key);
}

#[test]
fn an_invite_link_with_someone_elses_keys_is_refused() {
    let (admin, mut docs) = admin_with_two_keys();
    // An outsider's link for the team's workspace, with keys of their own.
    let outsider = mac();
    outsider.create(WS, None).unwrap();
    let theirs = outsider.invite(WS).unwrap();
    let ana = mac();
    assert!(ana.import_invite(WS, &theirs, &docs.0).unwrap_err().contains("announced"));
    // Even when whoever writes the workspace announces the outsider's key too: a Mac that already
    // trusts the team's admin doesn't take a link from someone it doesn't trust.
    docs.announce(outsider.rotate(WS).unwrap());
    let theirs = outsider.invite(WS).unwrap();
    ana.trust(WS, &signer(&admin)).unwrap();
    assert!(ana.import_invite(WS, &theirs, &docs.0).unwrap_err().contains("trusts"));
    assert!(!ana.status(WS).unwrap().has_key);
    // A version-1 link (no signer) is refused.
    let v1 = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&json!({"v": 1, "ws": WS, "keys": {"1": URL_SAFE_NO_PAD.encode([1u8; 32])}})).unwrap());
    assert!(ana.import_invite(WS, &v1, &docs.0).is_err());
}

// ---- Keychain safety -------------------------------------------------------------------------

/// A Keychain whose reads are slow (so first calls overlap) and whose writes can be made to fail.
#[derive(Default)]
struct SlowStore {
    inner: MemStore,
    fail: std::sync::atomic::AtomicBool,
}
impl SecretStore for SlowStore {
    fn get(&self, n: &str) -> Result<Option<String>, String> {
        std::thread::sleep(std::time::Duration::from_millis(20));
        self.inner.get(n)
    }
    fn set(&self, n: &str, v: &str) -> Result<(), String> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            return Err("The Keychain refused.".into());
        }
        self.inner.set(n, v)
    }
    fn delete(&self, n: &str) -> Result<(), String> {
        self.inner.delete(n)
    }
}

#[test]
fn first_uses_at_the_same_time_make_one_device_key_and_one_ring() {
    let k = Arc::new(WorkspaceKeys::new(SlowStore::default()));
    let devices: Vec<Device> = (0..8)
        .map(|_| {
            let k = Arc::clone(&k);
            std::thread::spawn(move || k.device(WS).unwrap())
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();
    assert!(devices.iter().all(|d| *d == devices[0]), "one device key");
    // The Keychain holds that same key: a relaunch registers the same device.
    let again = WorkspaceKeys::new(SlowStore::default());
    again.inner_store_copy(&k.store);
    assert_eq!(again.device(WS).unwrap(), devices[0]);

    let made: Vec<Result<Announced, String>> = (0..8)
        .map(|_| {
            let k = Arc::clone(&k);
            std::thread::spawn(move || k.create(WS, None))
        })
        .collect::<Vec<_>>()
        .into_iter()
        .map(|h| h.join().unwrap())
        .collect();
    assert_eq!(made.iter().filter(|r| r.is_ok()).count(), 1, "one key 1: {made:?}");
    let blob = k.seal(WS, None, &[item("apps/a", "name", "\"Web\"")]).unwrap();
    let relaunched = WorkspaceKeys::new(SlowStore::default());
    relaunched.inner_store_copy(&k.store);
    assert_eq!(relaunched.open(WS, &[open_item("apps/a", "name", &blob[0])]).unwrap(), vec![Some("\"Web\"".into())], "the Keychain holds the key in use");
}

#[test]
fn a_failed_keychain_write_leaves_the_mac_as_it_was() {
    use std::sync::atomic::Ordering;
    let k = WorkspaceKeys::new(SlowStore::default());
    k.device(WS).unwrap();
    k.store.fail.store(true, Ordering::SeqCst);
    assert!(k.create(WS, None).unwrap_err().contains("Keychain"));
    assert!(!k.status(WS).unwrap().has_key, "not used when it wasn't saved");
    assert!(k.trust(WS, &signer_public(&seq(5))).is_err());
    assert!(!k.status(WS).unwrap().pinned);
    k.store.fail.store(false, Ordering::SeqCst);
    assert_eq!(k.create(WS, None).unwrap().kid, 1);
    k.store.fail.store(true, Ordering::SeqCst);
    assert!(k.rotate(WS).is_err());
    assert!(k.retire(WS, 1).is_ok(), "nothing to drop: nothing written");
    assert_eq!(k.status(WS).unwrap().kids, vec![1]);
    // A device key whose write failed isn't kept: the next try makes and saves one.
    let fresh = WorkspaceKeys::new(SlowStore::default());
    fresh.store.fail.store(true, Ordering::SeqCst);
    assert!(fresh.device(WS).is_err());
    fresh.store.fail.store(false, Ordering::SeqCst);
    let d = fresh.device(WS).unwrap();
    assert_eq!(fresh.device(WS).unwrap(), d);
}

impl WorkspaceKeys<SlowStore> {
    fn inner_store_copy(&self, from: &SlowStore) {
        for (n, v) in from.inner.0.lock().unwrap().iter() {
            self.store.inner.set(n, v).unwrap();
        }
    }
}

#[test]
fn a_device_key_from_before_signing_keys_keeps_its_id() {
    let k = mac();
    let x: [u8; 32] = seq(0x20);
    k.store.set(&format!("device:{WS}"), &STANDARD.encode(x)).unwrap();
    let d = k.device(WS).unwrap();
    assert_eq!(d.id, device_id(&PublicKey::from(&StaticSecret::from(x)).to_bytes()));
    assert!(!d.sign_key.is_empty());
    let relaunched = WorkspaceKeys::new(MemStore::default());
    relaunched.store.set(&format!("device:{WS}"), &k.store.get(&format!("device:{WS}")).unwrap().unwrap()).unwrap();
    assert_eq!(relaunched.device(WS).unwrap(), d, "its signing key is saved");
}

#[test]
fn the_recovery_code_is_kept_for_the_kit_only_a_while() {
    let admin = mac();
    admin.create(WS, None).unwrap();
    admin.recovery_new(WS).unwrap();
    assert!(admin.pending_code(WS).is_some());
    if let Some(p) = admin.pending.lock().unwrap().as_mut() {
        p.2 = Instant::now().checked_sub(PENDING_FOR + Duration::from_secs(1)).unwrap();
    }
    assert!(admin.pending_code(WS).is_none());
    assert!(admin.pending.lock().unwrap().is_none(), "and forgotten");
}

#[test]
fn trust_lists_that_are_too_long_are_refused() {
    let k = mac();
    let e = k.endorse(WS, &signer_public(&seq(3))).unwrap();
    let t = Trust { signers: vec![e; MAX_SIGNERS + 1], ..Default::default() };
    assert!(k.signer_trusted(WS, "x", &t).is_err());
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

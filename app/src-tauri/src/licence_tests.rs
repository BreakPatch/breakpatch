//! Unit tests for licence.rs. `testdata/licence-token-v1.json` is a copy of the back office's
//! test vector (functions/test/vectors/token-v1.json): the RFC 8032 §7.1 test 1 key, public.

use super::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use ed25519_dalek::{Signer, SigningKey};

const VECTOR: &str = include_str!("testdata/licence-token-v1.json");
/// RFC 8032 §7.1 test 1 (public; tests and dev builds only).
const RFC_SEED_HEX: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const RFC_PUB_B64: &str = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
/// The owner's real signing key (backoffice/keys/public-keys.json in the Team repo).
const REAL_KEYS: &str = r#"{"2026-09":"nq3dlCbsXPq4AYEtaLAy3zwyV7gXgRa-sNTye4NZ75M"}"#;
const REAL_HEX: &str = "9eaddd9426ec5cfab801812d68b032df3c3257b8178116beb0d4f27b8359ef93";

fn vector() -> Value {
    serde_json::from_str(VECTOR).unwrap()
}

fn keys(kid: &str) -> KeyTable {
    KeyTable::parse(&format!(r#"{{"{kid}":"{RFC_PUB_B64}"}}"#)).unwrap()
}

fn seed() -> SigningKey {
    let bytes: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&RFC_SEED_HEX[i * 2..i * 2 + 2], 16).unwrap()).collect();
    SigningKey::from_bytes(&bytes.try_into().unwrap())
}

/// Signs a token like the service does, with the RFC key.
fn sign(kid: &str, payload: &Value) -> String {
    let h = URL_SAFE_NO_PAD.encode(json!({ "alg": "EdDSA", "typ": "JWT", "kid": kid }).to_string());
    let p = URL_SAFE_NO_PAD.encode(payload.to_string());
    let sig = seed().sign(format!("{h}.{p}").as_bytes());
    format!("{h}.{p}.{}", URL_SAFE_NO_PAD.encode(sig.to_bytes()))
}

const IAT: i64 = 1_790_000_000;
const DAY: i64 = 86_400;

fn payload(ws: &str, iat: i64) -> Value {
    json!({
        "iss": "breakpatch-backoffice", "v": 1, "licenceId": "L1", "activationId": "p_1", "tier": "team",
        "features": ["collaboration", "versions", "runner"], "seats": 10, "machines": 1,
        "subjectHash": "abc", "kind": "person", "workspaceProjectId": ws,
        "iat": iat, "exp": iat + 7 * DAY, "offlineUntil": iat + 30 * DAY, "licenceExpiresAt": iat + 365 * DAY,
    })
}

#[derive(Default, Clone)]
struct MemStore(Arc<Mutex<HashMap<String, String>>>);
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

fn stored(token: Option<String>) -> Stored {
    Stored {
        key: "BP-2HC6-FWG8-CR0K-VBDB".into(),
        subject: "ana@acme.com".into(),
        kind: Kind::Person,
        workspace_project_id: "acme-breakpatch".into(),
        machine_name: None,
        token,
        seats_used: Some(8),
        machines_used: None,
        customer_name: Some("Acme".into()),
        error: None,
        seen_at: None,
        clock_back: false,
        tier: None,
    }
}

/// This test Mac's hashed hardware id (the deviceId it sends).
const DEVICE: &str = "0123456789abcdef0123456789abcdef";

/// The Team workspace the tests have open, and its Keychain entry.
const WS: &str = "team:acme-breakpatch/breakpatch";
const ENTRY: &str = "licence:team:acme-breakpatch/breakpatch";

/// A licensing with the test workspace selected (without moving anything: see the tests below).
fn licensing(store: MemStore, url: &str, clock: Arc<AtomicI64>) -> Licensing<MemStore> {
    let l = unselected(store, url, clock);
    *l.selected.lock().unwrap() = Some(WS.into());
    l
}

fn unselected(store: MemStore, url: &str, clock: Arc<AtomicI64>) -> Licensing<MemStore> {
    Licensing::new(store, keys("test-rfc8032"), url.into(), Box::new(|| ("machine-1".into(), Some("QA Mac".into()))))
        .with_clock(Box::new(move || clock.load(Ordering::SeqCst)))
        .with_hardware(Box::new(|| Some(DEVICE.into())))
}

fn put(store: &MemStore, s: &Stored) {
    store.set(ENTRY, &serde_json::to_string(s).unwrap()).unwrap();
}

// ---- Tokens ----


/// Where a Solo customer frees their Mac or renews (the back office's account page): Solo's messages name it.
const ACCOUNT_SITE: &str = "account.breakpatch.dev";

#[test]
fn the_test_vector_verifies() {
    let v = vector();
    let kid = v["kid"].as_str().unwrap();
    let table = KeyTable::parse(&format!(r#"{{"{kid}":"{}"}}"#, v["publicKeyBase64url"].as_str().unwrap())).unwrap();
    let c = verify(v["token"].as_str().unwrap(), &table).unwrap();
    assert_eq!(c.licence_id, v["payload"]["licenceId"]);
    assert_eq!(c.workspace_project_id, "acme-breakpatch");
    assert_eq!(c.seats, 10);
    assert_eq!(c.kind, Kind::Person);
    assert_eq!(c.exp, v["payload"]["exp"].as_i64().unwrap());
    assert_eq!(c.features.len(), 8);
}

#[test]
fn signing_the_vector_payload_reproduces_the_token() {
    // Ed25519 is deterministic: our test signer matches the service byte for byte.
    let v = vector();
    let h = v["token"].as_str().unwrap().split('.').next().unwrap();
    let p = v["token"].as_str().unwrap().split('.').nth(1).unwrap();
    let sig = seed().sign(format!("{h}.{p}").as_bytes());
    let hex: String = sig.to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, v["signatureHex"].as_str().unwrap());
}

#[test]
fn a_tampered_payload_is_rejected() {
    let v = vector();
    let table = keys(v["kid"].as_str().unwrap());
    assert_eq!(verify(v["tamperedToken"].as_str().unwrap(), &table), Err(VerifyError::BadSignature));
}

#[test]
fn an_unknown_kid_is_rejected() {
    let v = vector();
    assert_eq!(verify(v["token"].as_str().unwrap(), &keys("2026-09")), Err(VerifyError::UnknownKid));
}

#[test]
fn malformed_and_foreign_tokens_are_rejected() {
    let table = keys("test-rfc8032");
    assert_eq!(verify("abc", &table), Err(VerifyError::Malformed));
    assert_eq!(verify("a.b.c.d", &table), Err(VerifyError::Malformed));
    let mut p = payload("acme-breakpatch", IAT);
    p["iss"] = json!("someone-else");
    assert_eq!(verify(&sign("test-rfc8032", &p), &table), Err(VerifyError::NotOurs));
}

#[test]
fn a_token_signed_by_another_key_is_invalid() {
    let other = SigningKey::from_bytes(&[7u8; 32]);
    let pubkey = URL_SAFE_NO_PAD.encode(other.verifying_key().to_bytes());
    let table = KeyTable::parse(&format!(r#"{{"test-rfc8032":"{pubkey}"}}"#)).unwrap();
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    assert_eq!(verify(&token, &table), Err(VerifyError::BadSignature));
    let st = evaluate(Some(&stored(Some(token))), &table, IAT + 1, None, None);
    assert_eq!(st.state, State::Invalid);
    assert!(st.features.is_empty());
    assert_eq!(st.code.as_deref(), Some("invalid_token"));
}

// ---- Keys ----

#[test]
fn the_real_key_2026_09_parses() {
    let t = KeyTable::parse(REAL_KEYS).unwrap();
    assert_eq!(t.kids(), vec!["2026-09"]);
    let hex: String = t.0["2026-09"].to_bytes().iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, REAL_HEX);
}

#[test]
fn bad_key_tables_are_refused() {
    assert!(KeyTable::parse("[]").is_err());
    assert!(KeyTable::parse(r#"{"x":"not base64!"}"#).is_err());
    assert!(KeyTable::parse(r#"{"x":"AAAA"}"#).is_err());
    assert!(KeyTable::parse("{}").unwrap().is_empty());
}

#[test]
fn plain_builds_have_no_keys() {
    if !KeyTable::built_in() {
        assert!(KeyTable::compiled().is_empty());
        assert_eq!(built::DIGESTS, "");
    }
}

// ---- States ----

#[test]
fn active_then_grace_then_expired_as_the_clock_moves() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let clock = Arc::new(AtomicI64::new(IAT + 60));
    let l = licensing(store, "http://127.0.0.1:9", clock.clone());

    let st = l.status(Some("acme-breakpatch"));
    assert_eq!(st.state, State::Active);
    assert_eq!(st.features, vec!["collaboration", "versions", "runner"]);
    assert_eq!((st.tier.as_deref(), st.seats, st.seats_used), (Some("team"), Some(10), Some(8)));
    assert_eq!(st.key_hint.as_deref(), Some("VBDB"));
    assert_eq!(st.message, None);

    clock.store(IAT + 7 * DAY, Ordering::SeqCst); // exp passed
    let st = l.status(None);
    assert_eq!(st.state, State::Grace);
    assert_eq!(st.features.len(), 3, "grace still unlocks");
    assert_eq!(st.code.as_deref(), Some("grace"));

    clock.store(IAT + 30 * DAY, Ordering::SeqCst); // offlineUntil passed
    let st = l.status(None);
    assert_eq!(st.state, State::Expired);
    assert!(st.features.is_empty());
    assert_eq!(st.message.as_deref(), Some("Reconnect to check your licence."));
}

#[test]
fn the_licence_end_date_expires_it_even_with_a_fresh_token() {
    let mut p = payload("acme-breakpatch", IAT);
    p["licenceExpiresAt"] = json!(IAT + DAY);
    let st = evaluate(Some(&stored(Some(sign("test-rfc8032", &p)))), &keys("test-rfc8032"), IAT + DAY, None, None);
    assert_eq!(st.state, State::Expired);
    assert_eq!(st.code.as_deref(), Some("expired"));
    assert!(st.features.is_empty());
}

#[test]
fn offline_use_is_capped_at_offline_days() {
    let mut p = payload("acme-breakpatch", IAT);
    p["offlineUntil"] = json!(IAT + 90 * DAY);
    let s = stored(Some(sign("test-rfc8032", &p)));
    let t = keys("test-rfc8032");
    assert_eq!(evaluate(Some(&s), &t, IAT + OFFLINE_DAYS * DAY - 1, None, None).state, State::Grace);
    let st = evaluate(Some(&s), &t, IAT + OFFLINE_DAYS * DAY, None, None);
    assert_eq!(st.state, State::Expired);
    assert_eq!(st.offline_until, Some(IAT + OFFLINE_DAYS * DAY));
}

#[test]
fn a_token_for_another_workspace_unlocks_nothing_there() {
    let s = stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT))));
    let st = evaluate(Some(&s), &keys("test-rfc8032"), IAT + 1, Some("other-project"), None);
    assert_eq!(st.state, State::None);
    assert!(st.features.is_empty());
    assert_eq!(st.code.as_deref(), Some("other_workspace"));
}

#[test]
fn nothing_stored_is_none_and_a_refusal_says_why() {
    let t = keys("test-rfc8032");
    let st = evaluate(None, &t, IAT, None, None);
    assert_eq!((st.state, st.code.clone()), (State::None, None));
    let mut s = stored(None);
    s.error = Some("out_of_seats".into());
    let st = evaluate(Some(&s), &t, IAT, None, None);
    assert_eq!(st.state, State::None);
    assert_eq!(st.message.as_deref(), Some("Your team is out of seats. Ask your admin to add one."));
}

#[tokio::test]
async fn without_keys_everything_is_unavailable() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let l = Licensing::new(store, KeyTable::default(), "http://127.0.0.1:9".into(), Box::new(|| ("m".into(), None)));
    let st = l.status(None);
    assert_eq!(st.state, State::Unavailable);
    assert_eq!(st.message.as_deref(), Some("Licences aren't available in this edition of Breakpatch."));
    let req = ActivateRequest {
        ws_key: None,
        key: "BP-X".into(),
        key_from: None,
        workspace_project_id: "w".into(),
        subject: Some("a@b.c".into()),
        kind: "person".into(),
    };
    assert_eq!(l.activate(req).await.unwrap_err().code, "unavailable");
    assert_eq!(l.refresh().await.state, State::Unavailable);
    assert_eq!(l.release(None).await.state, State::Unavailable);
}

#[test]
fn the_engine_gets_the_stored_token_only_with_keys_built_in() {
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let store = MemStore::default();
    let clock = Arc::new(AtomicI64::new(IAT));
    let l = licensing(store.clone(), "http://127.0.0.1:9", Arc::clone(&clock));
    assert_eq!(l.engine_token(), None);
    let l = licensing(store.clone(), "http://127.0.0.1:9", Arc::clone(&clock));
    put(&store, &stored(Some(token.clone())));
    assert_eq!(l.engine_token().as_deref(), Some(token.as_str()));
    // Even an expired token is handed over: the engine works out the state itself.
    clock.store(IAT + 400 * DAY, Ordering::SeqCst);
    assert_eq!(l.engine_token().as_deref(), Some(token.as_str()));
    let community =
        Licensing::new(store, KeyTable::default(), "http://127.0.0.1:9".into(), Box::new(|| ("m".into(), None)));
    assert_eq!(community.engine_token(), None);
}

// ---- Error mapping ----

#[test]
fn service_codes_map_to_plain_messages() {
    assert_eq!(message_for("out_of_seats", None), "Your team is out of seats. Ask your admin to add one.");
    assert_eq!(message_for("unknown_key", None), "This licence key isn't recognised. Check it and try again.");
    assert_eq!(message_for("revoked", None), "This licence is no longer active. Ask your admin for help.");
    assert_eq!(message_for("released", None), "This seat was freed. Sign in again to take a seat.");
    assert_eq!(
        message_for("offline", None),
        "Couldn't reach the licence service. Check your connection and try again."
    );
    // A code added to the service later: its own message, else a plain fallback.
    assert_eq!(message_for("new_code", Some("Something new.")), "Something new.");
    assert_eq!(message_for("new_code", None), "The licence couldn't be checked.");
}

#[test]
fn the_status_serialises_for_the_ui() {
    let s = stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT))));
    let v = serde_json::to_value(evaluate(Some(&s), &keys("test-rfc8032"), IAT, None, None)).unwrap();
    assert_eq!(v["state"], "active");
    assert_eq!(v["licenceExpiresAt"], IAT + 365 * DAY);
    assert_eq!(v["offlineUntil"], IAT + 30 * DAY);
    assert_eq!(v["kind"], "person");
    let text = v.to_string();
    assert!(!text.contains("BP-2HC6"), "the key never reaches the UI");
    assert!(!text.contains(s.token.as_deref().unwrap()), "nor the token");
}

// ---- Talking to the service (a canned local server) ----

/// Answers each request with the next (status, body) and records the paths asked for.
async fn canned(answers: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<String>>>) {
    let (url, seen, _) = canned_bodies(answers).await;
    (url, seen)
}

/// `canned`, also keeping each request's JSON body.
async fn canned_bodies(answers: Vec<(u16, Value)>) -> (String, Arc<Mutex<Vec<String>>>, Arc<Mutex<Vec<Value>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let bodies = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    let body_log = bodies.clone();
    tokio::spawn(async move {
        for (status, body) in answers {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).await.unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf);
                if let Some(end) = text.find("\r\n\r\n") {
                    let len = text[..end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap_or(0))
                        })
                        .unwrap_or(0);
                    if buf.len() >= end + 4 + len {
                        break;
                    }
                }
            }
            let text = String::from_utf8_lossy(&buf);
            log.lock().unwrap().push(text.split_whitespace().nth(1).unwrap_or("").to_string());
            let json = text.find("\r\n\r\n").and_then(|i| serde_json::from_str(&text[i + 4..]).ok());
            body_log.lock().unwrap().push(json.unwrap_or(Value::Null));
            let body = body.to_string();
            let resp = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (url, seen, bodies)
}

fn ok_answer(token: &str) -> Value {
    json!({ "ok": true, "token": token, "licence": { "seatsUsed": 3, "machinesUsed": 0, "customerName": "Acme" } })
}

fn refusal(code: &str) -> Value {
    json!({ "ok": false, "error": { "code": code, "message": "from the service" } })
}

fn person(key: &str, subject: &str) -> ActivateRequest {
    ActivateRequest {
        ws_key: None,
        key: key.into(),
        key_from: None,
        workspace_project_id: "acme-breakpatch".into(),
        subject: Some(subject.into()),
        kind: "person".into(),
    }
}

#[tokio::test]
async fn activate_stores_the_token_and_key_in_the_keychain() {
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let (url, seen) = canned(vec![(200, ok_answer(&token))]).await;
    let store = MemStore::default();
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    let st = l.activate(person("BP-2HC6-FWG8-CR0K-VBDB", "ana@acme.com")).await.unwrap();
    assert_eq!(st.state, State::Active);
    assert_eq!(st.seats_used, Some(3));
    assert_eq!(seen.lock().unwrap().as_slice(), ["/activate"]);
    let saved: Stored = serde_json::from_str(&store.get(ENTRY).unwrap().unwrap()).unwrap();
    assert_eq!(saved.token.as_deref(), Some(token.as_str()));
    assert_eq!(saved.key, "BP-2HC6-FWG8-CR0K-VBDB");
    assert_eq!(saved.subject, "ana@acme.com");
}

#[tokio::test]
async fn a_machine_activates_with_this_macs_id() {
    let mut p = payload("acme-breakpatch", IAT);
    p["kind"] = json!("machine");
    let (url, _) = canned(vec![(200, ok_answer(&sign("test-rfc8032", &p)))]).await;
    let store = MemStore::default();
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    let req = ActivateRequest {
        ws_key: None,
        key: "BP-K".into(),
        key_from: None,
        workspace_project_id: "acme-breakpatch".into(),
        subject: None,
        kind: "machine".into(),
    };
    assert_eq!(l.activate(req).await.unwrap().kind, Some(Kind::Machine));
    let saved: Stored = serde_json::from_str(&store.get(ENTRY).unwrap().unwrap()).unwrap();
    assert_eq!((saved.subject.as_str(), saved.machine_name.as_deref()), ("machine-1", Some("QA Mac")));
}

#[tokio::test]
async fn out_of_seats_is_remembered_with_its_message() {
    let (url, _) = canned(vec![(409, refusal("out_of_seats"))]).await;
    let l = licensing(MemStore::default(), &url, Arc::new(AtomicI64::new(IAT)));
    let f = l.activate(person("BP-K", "bo@acme.com")).await.unwrap_err();
    assert_eq!(
        f,
        Failure {
            code: "out_of_seats".into(),
            message: "Your team is out of seats. Ask your admin to add one.".into(),
            tier: None,
        }
    );
    let st = l.status(None);
    assert_eq!((st.state, st.code.as_deref()), (State::None, Some("out_of_seats")));
}

#[tokio::test]
async fn a_mistyped_replacement_key_keeps_the_licence_that_works() {
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let store = MemStore::default();
    put(&store, &stored(Some(token)));
    let (url, _) = canned(vec![(404, refusal("unknown_key"))]).await;
    let l = licensing(store, &url, Arc::new(AtomicI64::new(IAT + 1)));
    assert_eq!(l.activate(person("BP-OTHER-KEY", "ana@acme.com")).await.unwrap_err().code, "unknown_key");
    assert_eq!(l.status(None).state, State::Active);
}

#[tokio::test]
async fn a_token_signed_with_an_unknown_key_is_not_stored() {
    let (url, _) = canned(vec![(200, ok_answer(&sign("someone-elses-kid", &payload("acme-breakpatch", IAT))))]).await;
    let store = MemStore::default();
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT)));
    assert_eq!(l.activate(person("BP-K", "ana@acme.com")).await.unwrap_err().code, "invalid_token");
    assert!(store.get(ENTRY).unwrap().is_none());
}

#[tokio::test]
async fn refresh_offline_keeps_the_token_through_grace() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let clock = Arc::new(AtomicI64::new(IAT + 8 * DAY));
    let l = licensing(store, "http://127.0.0.1:9", clock); // nothing listens on port 9
    let st = l.refresh().await;
    assert_eq!(st.state, State::Grace);
    assert_eq!(st.features.len(), 3);
}

#[tokio::test]
async fn refresh_takes_a_freed_seat_again_with_the_stored_key() {
    let old = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let new = sign("test-rfc8032", &payload("acme-breakpatch", IAT + DAY));
    let (url, seen) = canned(vec![(410, refusal("released")), (200, ok_answer(&new))]).await;
    let store = MemStore::default();
    put(&store, &stored(Some(old)));
    let l = licensing(store, &url, Arc::new(AtomicI64::new(IAT + DAY + 1)));
    let st = l.refresh().await;
    assert_eq!(st.state, State::Active);
    assert_eq!(st.expires_at, Some(IAT + 8 * DAY));
    assert_eq!(seen.lock().unwrap().as_slice(), ["/refresh", "/activate"]);
}

#[tokio::test]
async fn a_revoked_licence_ends_at_the_next_refresh() {
    let (url, _) = canned(vec![(403, refusal("revoked"))]).await;
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let l = licensing(store, &url, Arc::new(AtomicI64::new(IAT + 1)));
    let st = l.refresh().await;
    assert_eq!(st.state, State::None);
    assert!(st.features.is_empty());
    assert_eq!(st.message.as_deref(), Some("This licence is no longer active. Ask your admin for help."));
}

#[tokio::test]
async fn release_gives_the_seat_back_and_forgets_it() {
    let (url, seen) = canned(vec![(200, json!({ "ok": true, "released": true }))]).await;
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    assert_eq!(l.release(None).await.state, State::None);
    assert_eq!(seen.lock().unwrap().as_slice(), ["/release"]);
    assert!(store.get(ENTRY).unwrap().is_none());
}

#[tokio::test]
async fn switching_person_releases_the_old_seat_first() {
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let (url, seen) = canned(vec![(200, json!({ "ok": true, "released": true })), (200, ok_answer(&token))]).await;
    let store = MemStore::default();
    put(&store, &stored(Some(token.clone())));
    let l = licensing(store, &url, Arc::new(AtomicI64::new(IAT + 1)));
    l.activate(person("BP-2HC6-FWG8-CR0K-VBDB", "bo@acme.com")).await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["/release", "/activate"]);
}

// ---- Machine id ----

#[test]
fn the_platform_uuid_is_read_from_ioreg() {
    let text = "+-o J314sAP  <class IOPlatformExpertDevice>\n    \"IOPlatformSerialNumber\" = \"X\"\n    \"IOPlatformUUID\" = \"1A2B3C4D-0000-1111-2222-333344445555\"\n";
    assert_eq!(parse_ioreg_uuid(text).as_deref(), Some("1A2B3C4D-0000-1111-2222-333344445555"));
    assert_eq!(parse_ioreg_uuid("nothing"), None);
    let h = hash_id("1A2B3C4D-0000-1111-2222-333344445555");
    assert_eq!(h.len(), 32);
    assert!(!h.contains("1A2B"));
}

#[test]
fn a_generated_machine_id_is_stable() {
    let dir = tempfile::tempdir().unwrap();
    let a = stored_id(dir.path());
    assert_eq!(a.len(), 32);
    assert_eq!(stored_id(dir.path()), a);
    let other = tempfile::tempdir().unwrap();
    assert_ne!(stored_id(other.path()), a);
}

// ---- Usage counts with the refresh (usage.rs) ----

fn with_usage(l: Licensing<MemStore>) -> (Licensing<MemStore>, Arc<UsageStore>) {
    let u = Arc::new(UsageStore::new(None, crate::usage::Edition::Team, false));
    (l.with_usage(Arc::clone(&u)), u)
}

#[tokio::test]
async fn refresh_carries_the_usage_counts_and_clears_them_when_taken() {
    use crate::usage::{Event, Source};
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let next = sign("test-rfc8032", &payload("acme-breakpatch", IAT + DAY));
    let mut taken = ok_answer(&next);
    taken["usageAccepted"] = json!(true);
    let (url, _, bodies) = canned_bodies(vec![(200, taken)]).await;
    let (l, u) = with_usage(licensing(store, &url, Arc::new(AtomicI64::new(IAT + DAY))));
    u.record(Event::TestCreated, IAT, Some(WS));
    u.record(Event::Run { source: Source::Schedule, passed: true }, IAT, Some(WS));
    u.record(Event::Run { source: Source::Manual, passed: false }, IAT, Some(WS));
    assert_eq!(l.refresh().await.state, State::Active);
    let body = bodies.lock().unwrap()[0].clone();
    assert_eq!(
        body["usage"],
        json!({ "testsCreated": 1, "runs": { "manual": 1, "schedule": 1, "runner": 0, "ci": 0 }, "runsPassed": 1, "runsFailed": 1, "activeDays": 1 })
    );
    let keys: Vec<&str> = body.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["deviceId", "token", "usage"], "nothing else goes with it");
    assert_eq!(u.pending_team(WS), None);
}

#[tokio::test]
async fn usage_not_taken_waits_for_the_next_refresh() {
    use crate::usage::Event;
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let next = sign("test-rfc8032", &payload("acme-breakpatch", IAT + DAY));
    let mut refused = ok_answer(&next);
    refused["usageAccepted"] = json!(false);
    // An older service that doesn't know about usage says nothing: that isn't "taken" either.
    let (url, _, _) = canned_bodies(vec![(200, refused), (200, ok_answer(&next)), (503, json!({}))]).await;
    let (l, u) = with_usage(licensing(store, &url, Arc::new(AtomicI64::new(IAT + DAY))));
    u.record(Event::TestCreated, IAT, Some(WS));
    l.refresh().await;
    l.refresh().await;
    l.refresh().await;
    assert_eq!(u.pending_team(WS).unwrap().tests_created, 1);
}

#[tokio::test]
async fn refresh_without_counts_sends_only_the_token() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let (url, _, bodies) =
        canned_bodies(vec![(200, ok_answer(&sign("test-rfc8032", &payload("acme-breakpatch", IAT + DAY))))]).await;
    let (l, _u) = with_usage(licensing(store, &url, Arc::new(AtomicI64::new(IAT + DAY))));
    l.refresh().await;
    assert!(bodies.lock().unwrap()[0].get("usage").is_none());
}

#[test]
fn a_licence_is_held_only_with_a_token() {
    let store = MemStore::default();
    let l = licensing(store.clone(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT)));
    assert!(!l.holds_token());
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let l = licensing(store, "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT)));
    assert!(l.holds_token());
}

// ---- This Mac's device (R1) ----

#[tokio::test]
async fn activate_and_refresh_send_this_macs_device_id() {
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let (url, _, bodies) = canned_bodies(vec![(200, ok_answer(&token)), (200, ok_answer(&token))]).await;
    let l = licensing(MemStore::default(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    l.activate(person("BP-K", "ana@acme.com")).await.unwrap();
    l.refresh().await;
    let bodies = bodies.lock().unwrap();
    assert_eq!(bodies[0]["deviceId"], DEVICE);
    assert_eq!(bodies[1]["deviceId"], DEVICE);
}

#[test]
fn without_a_hardware_id_the_device_id_is_random_and_kept_in_the_keychain() {
    let store = MemStore::default();
    let clock = Arc::new(AtomicI64::new(IAT));
    let make = || licensing(store.clone(), "http://127.0.0.1:9", Arc::clone(&clock)).with_hardware(Box::new(|| None));
    let id = make().device_id().unwrap();
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
    assert_eq!(store.get("device").unwrap().as_deref(), Some(id.as_str()));
    assert_eq!(make().device_id().unwrap(), id, "stable across launches");
    let other = licensing(MemStore::default(), "http://127.0.0.1:9", clock).with_hardware(Box::new(|| None));
    assert_ne!(other.device_id().unwrap(), id);
}

#[test]
fn a_token_bound_to_another_mac_is_invalid_here() {
    let t = keys("test-rfc8032");
    let mut p = payload("acme-breakpatch", IAT);
    p["dev"] = json!(device_hash("p_1", DEVICE));
    let mine = stored(Some(sign("test-rfc8032", &p)));
    assert_eq!(evaluate(Some(&mine), &t, IAT + 1, None, Some(DEVICE)).state, State::Active);
    let st = evaluate(Some(&mine), &t, IAT + 1, None, Some("ffffffffffffffffffffffffffffffff"));
    assert_eq!((st.state, st.code.as_deref()), (State::Invalid, Some("other_device")));
    assert!(st.features.is_empty());
    assert_eq!(st.message.as_deref(), Some("This licence was activated on another Mac. Sign in again on this one."));
    // The raw deviceId in `dev` counts too; a token without `dev` works on any Mac (older service).
    p["dev"] = json!(DEVICE);
    assert_eq!(
        evaluate(Some(&stored(Some(sign("test-rfc8032", &p)))), &t, IAT + 1, None, Some(DEVICE)).state,
        State::Active
    );
    let plain = stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT))));
    assert_eq!(evaluate(Some(&plain), &t, IAT + 1, None, Some("anything-at-all-0000")).state, State::Active);
}

#[test]
fn the_device_hash_matches_the_back_office() {
    // sha256("device:p_1:0123456789abcdef0123456789abcdef"), first 32 hex characters.
    use sha2::{Digest, Sha256};
    let want: String = Sha256::digest(b"device:p_1:0123456789abcdef0123456789abcdef")
        .iter()
        .take(16)
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(device_hash("p_1", DEVICE), want);
    assert_eq!(want.len(), 32);
}

#[tokio::test]
async fn a_copied_keychain_entry_doesnt_work_on_another_mac_and_the_engine_gets_nothing() {
    let mut p = payload("acme-breakpatch", IAT);
    p["dev"] = json!(device_hash("p_1", DEVICE));
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &p))));
    let other = licensing(store, "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT + 1)))
        .with_hardware(Box::new(|| Some("fedcba9876543210fedcba9876543210".into())));
    assert_eq!(other.status(None).state, State::Invalid);
    assert_eq!(other.engine_token(), None);
}

#[tokio::test]
async fn a_token_for_another_device_in_an_answer_is_not_stored() {
    let mut p = payload("acme-breakpatch", IAT);
    p["dev"] = json!(device_hash("p_1", "someone-elses-device-id"));
    let (url, _) = canned(vec![(200, ok_answer(&sign("test-rfc8032", &p)))]).await;
    let store = MemStore::default();
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    assert_eq!(l.activate(person("BP-K", "ana@acme.com")).await.unwrap_err().code, "invalid_token");
    assert!(serde_json::from_str::<Stored>(&store.get(ENTRY).unwrap().unwrap_or("{}".into()))
        .map_or(true, |s| s.token.is_none()));
}

#[tokio::test]
async fn over_seats_and_too_many_devices_say_so_plainly() {
    assert_eq!(
        message_for("over_seats", None),
        "Your team is using more seats than it pays for, so this Mac's seat was freed. Ask your admin to add seats, then sign in again."
    );
    assert_eq!(
        message_for("too_many_devices", None),
        "Your seat is already used on too many Macs. Ask your admin to free one, then sign in again."
    );
    // A refresh refused with over_seats leaves this Mac without a token, and says why.
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let (url, _) = canned(vec![(409, refusal("over_seats")), (409, refusal("too_many_devices"))]).await;
    let l = licensing(store, &url, Arc::new(AtomicI64::new(IAT + DAY)));
    let st = l.refresh().await;
    assert_eq!((st.state, st.code.as_deref()), (State::None, Some("over_seats")));
    let err = l.activate(person("BP-K", "ana@acme.com")).await.unwrap_err();
    assert_eq!(err.code, "too_many_devices");
    assert_eq!(err.message, message_for("too_many_devices", None));
}

// ---- The clock (R7) ----

#[test]
fn a_clock_set_back_makes_the_licence_invalid_until_an_online_refresh() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let clock = Arc::new(AtomicI64::new(IAT + 20 * DAY));
    let l = licensing(store.clone(), "http://127.0.0.1:9", Arc::clone(&clock));
    assert_eq!(l.status(None).state, State::Grace); // the latest time seen is kept
    clock.store(IAT + 3 * DAY, Ordering::SeqCst); // back 17 days: "active" again?
    let st = l.status(None);
    assert_eq!((st.state, st.code.as_deref()), (State::Invalid, Some("clock_back")));
    assert!(st.features.is_empty());
    assert_eq!(
        st.message.as_deref(),
        Some("This Mac's clock is behind. Set the right date and time, then reconnect to check your licence.")
    );
    assert_eq!(l.engine_token(), None, "the engine doesn't get it either");
    // Putting the clock forward again isn't enough; it stays invalid, even after a restart.
    clock.store(IAT + 20 * DAY, Ordering::SeqCst);
    assert_eq!(l.status(None).state, State::Invalid);
    let again = licensing(store, "http://127.0.0.1:9", clock);
    assert_eq!(again.status(None).code.as_deref(), Some("clock_back"));
}

#[test]
fn a_clock_behind_when_the_token_was_issued_is_caught_with_nothing_seen_before() {
    // faketime: a fresh install of an old token, with the clock a year back.
    let s = stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT))));
    let st = evaluate(Some(&s), &keys("test-rfc8032"), IAT - 398 * DAY, None, None);
    assert_eq!((st.state, st.code.as_deref()), (State::Invalid, Some("clock_back")));
    // A few hours of drift is fine.
    assert_eq!(evaluate(Some(&s), &keys("test-rfc8032"), IAT - 3_600, None, None).state, State::Active);
}

#[tokio::test]
async fn an_online_refresh_clears_a_clock_set_back() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let clock = Arc::new(AtomicI64::new(IAT + 10 * DAY));
    let l = licensing(store, "http://127.0.0.1:9", Arc::clone(&clock));
    l.status(None);
    clock.store(IAT + 5 * DAY, Ordering::SeqCst);
    assert_eq!(l.status(None).code.as_deref(), Some("clock_back"));
    // Offline, it stays invalid.
    assert_eq!(l.refresh().await.code.as_deref(), Some("clock_back"));
    // Online (the clock is right again): the service's new token clears it.
    clock.store(IAT + 10 * DAY + 60, Ordering::SeqCst);
    let fresh = sign("test-rfc8032", &payload("acme-breakpatch", IAT + 10 * DAY));
    let (url, _) = canned(vec![(200, ok_answer(&fresh))]).await;
    let online = Licensing::new(l.store.clone(), keys("test-rfc8032"), url, Box::new(|| ("m".into(), None)))
        .with_clock(Box::new(move || clock.load(Ordering::SeqCst)))
        .with_hardware(Box::new(|| Some(DEVICE.into())));
    online.select(Some(WS), None).unwrap();
    assert_eq!(online.refresh().await.state, State::Active);
}

#[test]
fn the_time_seen_is_written_at_most_hourly() {
    let store = MemStore::default();
    put(&store, &stored(Some(sign("test-rfc8032", &payload("acme-breakpatch", IAT)))));
    let clock = Arc::new(AtomicI64::new(IAT + 100));
    let l = licensing(store.clone(), "http://127.0.0.1:9", Arc::clone(&clock));
    let seen = || serde_json::from_str::<Stored>(&store.get(ENTRY).unwrap().unwrap()).unwrap().seen_at;
    l.status(None);
    assert_eq!(seen(), Some(IAT + 100));
    clock.store(IAT + 200, Ordering::SeqCst);
    l.status(None);
    assert_eq!(seen(), Some(IAT + 100));
    clock.store(IAT + 100 + 3_600, Ordering::SeqCst);
    l.status(None);
    assert_eq!(seen(), Some(IAT + 3_700));
}

// ---- The keys in the binary (R6) and the service address ----

#[test]
fn keys_are_built_in_masked_and_read_back_whole() {
    let raw = URL_SAFE_NO_PAD.decode(RFC_PUB_B64).unwrap();
    let key: [u8; 32] = raw.try_into().unwrap();
    let pad = [0x5au8; 32];
    let masked = embed::mask(&key, &pad);
    assert_ne!(masked, key);
    assert_eq!(embed::mask(&masked, &pad), key);
    let src = embed::render(&[("test-rfc8032".into(), key, RFC_PUB_B64.into(), pad)]);
    assert!(!src.contains(RFC_PUB_B64), "no base64 key in the build");
    let key_hex: String = key.iter().map(|b| format!("0x{b:02x}")).collect::<Vec<_>>().join(", ");
    assert!(!src.contains(&key_hex), "no raw key bytes either");
    assert!(src.contains(&embed::key_digest(RFC_PUB_B64)));
    assert!(embed::key_digest(RFC_PUB_B64).starts_with("bplk1:"));
    assert_eq!(embed::render(&[]).matches("[]").count(), 3);
}

#[test]
fn the_service_address_can_only_be_changed_in_development() {
    let local = Some("http://127.0.0.1:5001/x".to_string());
    assert_eq!(service_url_from(local.clone(), true), "http://127.0.0.1:5001/x");
    assert_eq!(service_url_from(local, false), DEFAULT_URL);
    assert_eq!(service_url_from(Some("  ".into()), true), DEFAULT_URL);
    assert_eq!(service_url_from(None, true), DEFAULT_URL);
}

// ---- Licences per workspace ----

fn active_token(ws: &str) -> String {
    sign("test-rfc8032", &payload(ws, IAT))
}

#[test]
fn the_licence_of_earlier_versions_moves_to_its_workspace_on_select() {
    let store = MemStore::default();
    store.set(LEGACY_ENTRY, &serde_json::to_string(&stored(Some(active_token("acme-breakpatch")))).unwrap()).unwrap();
    let clock = Arc::new(AtomicI64::new(IAT + DAY));
    let l = unselected(store.clone(), "http://127.0.0.1:9", clock);
    // Nothing selected: nothing unlocked, and the old entry stays.
    assert_eq!(l.status(None).state, State::None);
    assert!(store.get(LEGACY_ENTRY).unwrap().is_some());
    // A local folder and another workspace don't take it.
    assert_eq!(l.select(Some("local:c-1"), None).unwrap().state, State::None);
    assert_eq!(l.select(Some("team:globex/breakpatch"), Some("globex")).unwrap().state, State::None);
    assert!(store.get(LEGACY_ENTRY).unwrap().is_some());
    // Its own workspace does: copied to licence:<wsKey>, then removed.
    let st = l.select(Some(WS), Some("acme-breakpatch")).unwrap();
    assert_eq!(st.state, State::Active);
    assert!(store.get(LEGACY_ENTRY).unwrap().is_none());
    assert!(store.get(ENTRY).unwrap().is_some());
    // The device id stays one entry for the Mac.
    assert_eq!(l.select(Some("local:c-1"), None).unwrap().state, State::None);
    assert_eq!(l.select(Some(WS), Some("acme-breakpatch")).unwrap().state, State::Active);
}

#[test]
fn a_move_interrupted_after_the_copy_finishes_on_the_next_select() {
    let store = MemStore::default();
    let text = serde_json::to_string(&stored(Some(active_token("acme-breakpatch")))).unwrap();
    store.set(LEGACY_ENTRY, &text).unwrap();
    store.set(ENTRY, &text).unwrap();
    let l = unselected(store.clone(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT + DAY)));
    assert_eq!(l.select(Some(WS), Some("acme-breakpatch")).unwrap().state, State::Active);
    assert!(store.get(LEGACY_ENTRY).unwrap().is_none());
}

#[test]
fn switching_workspaces_never_shows_one_workspaces_licence_in_another() {
    let store = MemStore::default();
    store.set(ENTRY, &serde_json::to_string(&stored(Some(active_token("acme-breakpatch")))).unwrap()).unwrap();
    let l = unselected(store.clone(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT + DAY)));
    assert_eq!(l.select(Some(WS), Some("acme-breakpatch")).unwrap().features.len(), 3);
    assert!(l.holds_token() && l.engine_token().is_some());
    let other = l.select(Some("team:globex/breakpatch"), Some("globex")).unwrap();
    assert_eq!((other.state, other.features.len()), (State::None, 0));
    assert!(!l.holds_token() && l.engine_token().is_none());
    assert_eq!(l.select(None, None).unwrap().state, State::None);
    assert!(l.select(Some("bad key with spaces"), None).is_err());
    assert_eq!(l.status(None).state, State::None, "a refused key leaves nothing selected");
}

#[test]
fn a_licence_can_belong_to_a_local_folder_connection() {
    // The Solo plan (later): a licence for the tests folder, no workspace. Only the storage is here.
    let store = MemStore::default();
    let l = unselected(store.clone(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT + DAY)));
    l.select(Some("local:c-1"), None).unwrap();
    l.save_for("local:c-1", Some(stored(Some(active_token("acme-breakpatch")))));
    assert!(store.get("licence:local:c-1").unwrap().is_some());
    assert_eq!(l.status(None).state, State::Active);
    assert_eq!(l.select(Some(WS), None).unwrap().state, State::None);
}

#[tokio::test]
async fn releasing_one_workspace_keeps_the_others() {
    let (url, _) = canned(vec![(200, json!({ "ok": true }))]).await;
    let store = MemStore::default();
    let text = serde_json::to_string(&stored(Some(active_token("acme-breakpatch")))).unwrap();
    store.set(ENTRY, &text).unwrap();
    store.set("licence:team:globex/breakpatch", &text).unwrap();
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT + DAY)));
    l.select(Some(WS), Some("acme-breakpatch")).unwrap();
    l.release(Some("team:globex/breakpatch")).await;
    assert!(store.get("licence:team:globex/breakpatch").unwrap().is_none());
    assert_eq!(l.status(None).state, State::Active);
}

#[tokio::test]
async fn activating_needs_a_workspace_selected() {
    let l = unselected(MemStore::default(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT)));
    let f = l.activate(person("BP-2HC6-FWG8-CR0K-VBDB", "ana@acme.com")).await.unwrap_err();
    assert_eq!(f.code, "bad_request");
}

#[tokio::test]
async fn each_refresh_carries_its_own_workspaces_usage() {
    use crate::usage::Event;
    let (url, _, bodies) = canned_bodies(vec![(200, ok_answer(&active_token("acme-breakpatch")))]).await;
    let store = MemStore::default();
    store.set(ENTRY, &serde_json::to_string(&stored(Some(active_token("acme-breakpatch")))).unwrap()).unwrap();
    let (l, u) = with_usage(unselected(store, &url, Arc::new(AtomicI64::new(IAT + DAY))));
    l.select(Some(WS), Some("acme-breakpatch")).unwrap();
    u.record(Event::TestCreated, IAT, Some(WS));
    u.record(Event::TestCreated, IAT, Some("team:globex/breakpatch"));
    u.record(Event::TestCreated, IAT, Some("team:globex/breakpatch"));
    l.refresh().await;
    assert_eq!(bodies.lock().unwrap()[0]["usage"]["testsCreated"], 1);
    assert_eq!(u.pending_team("team:globex/breakpatch").unwrap().tests_created, 2);
}

fn legacy_with(store: &MemStore, s: &Stored) {
    store.set(LEGACY_ENTRY, &serde_json::to_string(s).unwrap()).unwrap();
}
fn entry_of(store: &MemStore, entry: &str) -> Stored {
    serde_json::from_str(&store.get(entry).unwrap().unwrap()).unwrap()
}

#[test]
fn the_earlier_licence_only_moves_to_a_workspace_of_its_project_that_may_take_it() {
    let store = MemStore::default();
    legacy_with(&store, &stored(Some(active_token("acme-breakpatch"))));
    let l = unselected(store.clone(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT + DAY)));
    // A key for another project, or a local folder, never takes it, whatever project is named.
    l.select(Some("team:globex/breakpatch"), Some("acme-breakpatch")).unwrap();
    l.select(Some("local:c-1"), Some("acme-breakpatch")).unwrap();
    // Another database of the same project, when the UI says it's ambiguous: left where it is.
    let qa = "team:acme-breakpatch/qa";
    assert_eq!(l.select_with(Some(qa), Some("acme-breakpatch"), false).unwrap().state, State::None);
    assert!(store.get(LEGACY_ENTRY).unwrap().is_some());
    assert!(store.get(&entry_for(qa)).unwrap().is_none());
    // The one it belongs to takes it.
    assert_eq!(l.select_with(Some(WS), Some("acme-breakpatch"), true).unwrap().state, State::Active);
    assert!(store.get(LEGACY_ENTRY).unwrap().is_none());
}

#[tokio::test]
async fn when_both_entries_differ_the_newer_token_stays_and_the_other_seat_goes_back() {
    let (url, seen, bodies) = canned_bodies(vec![(200, json!({ "ok": true }))]).await;
    let store = MemStore::default();
    // This workspace's entry, from before a downgrade; the older app then activated a new seat
    // (another person) in the single entry.
    let mine = stored(Some(active_token("acme-breakpatch")));
    put(&store, &mine);
    let newer_token = sign("test-rfc8032", &payload("acme-breakpatch", IAT + DAY));
    let mut old = stored(Some(newer_token.clone()));
    old.subject = "bo@acme.com".into();
    legacy_with(&store, &old);
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 2 * DAY)));
    l.select(Some(WS), Some("acme-breakpatch")).unwrap();
    l.release_stale().await;
    assert_eq!(entry_of(&store, ENTRY).token.as_deref(), Some(newer_token.as_str()));
    assert!(store.get(LEGACY_ENTRY).unwrap().is_none());
    assert_eq!(seen.lock().unwrap().as_slice(), ["/release"]);
    assert_eq!(bodies.lock().unwrap()[0]["token"], mine.token.unwrap());
}

#[tokio::test]
async fn the_same_seat_in_both_entries_is_only_forgotten() {
    let (url, seen) = canned(vec![]).await;
    let store = MemStore::default();
    let newer_token = sign("test-rfc8032", &payload("acme-breakpatch", IAT + DAY));
    put(&store, &stored(Some(newer_token.clone())));
    // The earlier entry: the same key and person, an older token for the same seat.
    legacy_with(&store, &stored(Some(active_token("acme-breakpatch"))));
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 2 * DAY)));
    l.select(Some(WS), Some("acme-breakpatch")).unwrap();
    l.release_stale().await;
    assert_eq!(entry_of(&store, ENTRY).token.as_deref(), Some(newer_token.as_str()));
    assert!(store.get(LEGACY_ENTRY).unwrap().is_none());
    assert!(seen.lock().unwrap().is_empty(), "nothing released");
}

#[tokio::test]
async fn activate_refresh_and_status_work_on_the_connection_they_name() {
    let token = active_token("acme-breakpatch");
    let (url, _) = canned(vec![(200, ok_answer(&token)), (200, ok_answer(&token))]).await;
    let store = MemStore::default();
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    // The UI asked for WS, then switched to a tests folder before the activation was handled.
    l.select(Some("local:c-1"), None).unwrap();
    let mut req = person("BP-2HC6-FWG8-CR0K-VBDB", "ana@acme.com");
    req.ws_key = Some(WS.into());
    assert_eq!(l.activate(req).await.unwrap().state, State::Active);
    assert!(store.get(ENTRY).unwrap().is_some());
    assert!(store.get("licence:local:c-1").unwrap().is_none(), "never stored under what's selected");
    assert_eq!(l.status(None).state, State::None);
    assert_eq!(l.status_for(Some(WS), Some("acme-breakpatch")).state, State::Active);
    assert_eq!(l.refresh_for(Some(WS)).await.state, State::Active);
    assert!(store.get("licence:local:c-1").unwrap().is_none());
}

#[test]
fn the_keychain_isnt_asked_about_the_earlier_entry_once_it_has_gone() {
    #[derive(Default, Clone)]
    struct Counting(MemStore, Arc<AtomicI64>);
    impl SecretStore for Counting {
        fn get(&self, n: &str) -> Result<Option<String>, String> {
            if n == LEGACY_ENTRY {
                self.1.fetch_add(1, Ordering::SeqCst);
            }
            self.0.get(n)
        }
        fn set(&self, n: &str, v: &str) -> Result<(), String> {
            self.0.set(n, v)
        }
        fn delete(&self, n: &str) -> Result<(), String> {
            self.0.delete(n)
        }
    }
    let store = Counting::default();
    let l = Licensing::new(
        store.clone(),
        keys("test-rfc8032"),
        "http://127.0.0.1:9".into(),
        Box::new(|| ("m".into(), None)),
    );
    assert!(!l.legacy_waiting());
    assert!(!l.legacy_waiting());
    assert_eq!(store.1.load(Ordering::SeqCst), 1);
}

// ---- Solo: a licence on a tests folder, with no workspace (issue #36) ----

const FOLDER: &str = "local:0123abcd4567ef89";
const FOLDER_ENTRY: &str = "licence:local:0123abcd4567ef89";

fn solo_payload(ws: &str, iat: i64) -> Value {
    let mut p = payload(ws, iat);
    p["licenceId"] = json!("SOLO1");
    p["tier"] = json!("solo");
    p["seats"] = json!(1);
    p["features"] = json!(["autoFix", "calibration", "schedules", "ci", "explain"]);
    p["parallelRuns"] = json!(1);
    p["dev"] = json!(device_hash("p_1", DEVICE));
    p
}

fn solo_token(ws: &str) -> String {
    sign("test-rfc8032", &solo_payload(ws, IAT))
}

/// A Solo activation on the tests folder: no workspace, the purchase email.
fn in_folder(key: &str, email: &str) -> ActivateRequest {
    ActivateRequest {
        ws_key: Some(FOLDER.into()),
        key: key.into(),
        key_from: None,
        workspace_project_id: "".into(),
        subject: Some(email.into()),
        kind: "person".into(),
    }
}

#[test]
fn a_solo_token_has_its_tier_no_workspace_and_one_run_at_a_time() {
    let c = verify(&solo_token(""), &keys("test-rfc8032")).unwrap();
    assert_eq!((c.tier.as_str(), c.workspace_project_id.as_str(), c.parallel_runs), ("solo", "", Some(1)));
    // Team tokens don't carry parallelRuns.
    assert_eq!(verify(&active_token("acme-breakpatch"), &keys("test-rfc8032")).unwrap().parallel_runs, None);
    let mut s = stored(Some(solo_token("")));
    s.workspace_project_id = "".into();
    let st = evaluate(Some(&s), &keys("test-rfc8032"), IAT + 1, Some(""), Some(DEVICE));
    assert_eq!(st.state, State::Active);
    assert_eq!((st.tier.as_deref(), st.parallel_runs, st.licence_id.as_deref()), (Some("solo"), Some(1), Some("SOLO1")));
    assert_eq!(st.features, ["autoFix", "calibration", "schedules", "ci", "explain"]);
    let json = serde_json::to_value(&st).unwrap();
    assert_eq!((json["parallelRuns"].clone(), json["licenceId"].clone()), (json!(1), json!("SOLO1")));
}

#[test]
fn a_folder_asks_for_a_token_with_no_workspace() {
    let k = keys("test-rfc8032");
    // The same seat, last activated for a workspace: the folder waits for its own activation.
    let st = evaluate(Some(&stored(Some(solo_token("acme-breakpatch")))), &k, IAT + 1, Some(""), Some(DEVICE));
    assert_eq!((st.state, st.code.as_deref()), (State::None, Some("other_workspace")));
    assert!(st.features.is_empty());
    // And a workspace doesn't take a folder's token.
    let st = evaluate(Some(&stored(Some(solo_token("")))), &k, IAT + 1, Some("acme-breakpatch"), Some(DEVICE));
    assert_eq!(st.code.as_deref(), Some("other_workspace"));
}

#[tokio::test]
async fn solo_activates_on_a_tests_folder_with_an_empty_workspace_and_this_mac() {
    let (url, _, bodies) = canned_bodies(vec![(200, ok_answer(&solo_token("")))]).await;
    let store = MemStore::default();
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    l.select(Some(FOLDER), None).unwrap();
    let st = l.activate(in_folder("BP-2HC6-FWG8-CR0K-VBDB", "sam@initech.com")).await.unwrap();
    assert_eq!((st.state, st.tier.as_deref()), (State::Active, Some("solo")));
    let body = bodies.lock().unwrap()[0].clone();
    assert_eq!(body["workspaceProjectId"], "");
    assert_eq!(body["deviceId"], DEVICE);
    assert_eq!(body["subject"], "sam@initech.com");
    let saved: Stored = serde_json::from_str(&store.get(FOLDER_ENTRY).unwrap().unwrap()).unwrap();
    assert_eq!((saved.workspace_project_id.as_str(), saved.tier.as_deref()), ("", Some("solo")));
    assert_eq!(l.status_for(Some(FOLDER), Some("")).state, State::Active);
    assert!(l.engine_token().is_some());
}

#[tokio::test]
async fn a_team_key_on_a_tests_folder_says_it_belongs_in_a_workspace() {
    let refused = json!({ "ok": false, "error": { "code": "needs_workspace", "message": "Words the app doesn't read.", "tier": "team" } });
    let (url, _) = canned(vec![(400, refused)]).await;
    let store = MemStore::default();
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT)));
    let f = l.activate(in_folder("BP-K", "sam@initech.com")).await.unwrap_err();
    assert_eq!(f.code, "needs_workspace");
    assert!(f.message.contains("used in a workspace"));
    assert!(store.get(FOLDER_ENTRY).unwrap().is_none(), "nothing kept for the folder");
}

#[tokio::test]
async fn solo_refusals_keep_the_services_solo_words() {
    let msg = "This Solo licence is in use on another Mac. Free it at account.breakpatch.dev, then try again.";
    let refused = json!({ "ok": false, "error": { "code": "solo_too_many_devices", "message": "Words the app doesn't read.", "tier": "solo" } });
    let (url, _) = canned(vec![(409, refused)]).await;
    let l = unselected(MemStore::default(), &url, Arc::new(AtomicI64::new(IAT)));
    l.select(Some(FOLDER), None).unwrap();
    let f = l.activate(in_folder("BP-K", "sam@initech.com")).await.unwrap_err();
    assert_eq!((f.code.as_str(), f.message.as_str(), f.tier.as_deref()), ("too_many_devices", msg, Some("solo")));
    // Kept with the tier, so the status says it in Solo's words too.
    let st = l.status_for(Some(FOLDER), Some(""));
    assert_eq!((st.tier.as_deref(), st.message.as_deref()), (Some("solo"), Some(msg)));
    assert!(st.message.unwrap().contains(ACCOUNT_SITE));
}

#[test]
fn a_solo_licence_is_worded_for_one_person() {
    assert!(message_for_tier("expired", None, true).contains("account.breakpatch.dev"));
    assert!(!message_for_tier("expired", None, true).contains("admin"));
    assert!(message_for_tier("out_of_seats", Some("from the service"), true).contains("Solo is for one person"));
    assert_eq!(message_for_tier("unknown_key", None, true), message_for("unknown_key", None));
    assert_eq!(message_for_tier("expired", None, false), message_for("expired", None));
    let mut s = stored(Some(solo_token("")));
    s.workspace_project_id = "".into();
    let st = evaluate(Some(&s), &keys("test-rfc8032"), IAT + 400 * DAY, Some(""), Some(DEVICE));
    assert_eq!(st.message.as_deref(), Some("Your Solo licence has expired. Renew it at account.breakpatch.dev."));
}

#[tokio::test]
async fn an_empty_key_brings_the_folders_solo_licence_into_a_workspace() {
    let (url, _, bodies) = canned_bodies(vec![(200, ok_answer(&solo_token("acme-breakpatch")))]).await;
    let store = MemStore::default();
    let mut folder = stored(Some(solo_token("")));
    folder.subject = "sam@initech.com".into();
    folder.workspace_project_id = "".into();
    store.set(FOLDER_ENTRY, &serde_json::to_string(&folder).unwrap()).unwrap();
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    let req = ActivateRequest {
        ws_key: Some(WS.into()),
        key: "".into(),
        key_from: Some(FOLDER.into()),
        workspace_project_id: "acme-breakpatch".into(),
        subject: Some("sam@initech.com".into()),
        kind: "person".into(),
    };
    assert_eq!(l.activate(req).await.unwrap().state, State::Active);
    let body = bodies.lock().unwrap()[0].clone();
    assert_eq!((body["key"].as_str(), body["subject"].as_str()), (Some("BP-2HC6-FWG8-CR0K-VBDB"), Some("sam@initech.com")));
    assert_eq!(entry_of(&store, ENTRY).key, "BP-2HC6-FWG8-CR0K-VBDB");
    // The folder keeps its own entry (the same seat).
    assert!(store.get(FOLDER_ENTRY).unwrap().is_some());
}

#[tokio::test]
async fn an_empty_key_takes_the_seat_again_with_the_stored_one_or_asks_for_it() {
    let (url, _, bodies) = canned_bodies(vec![(200, ok_answer(&solo_token("")))]).await;
    let store = MemStore::default();
    let mut folder = stored(None);
    folder.workspace_project_id = "".into();
    folder.error = Some("released".into());
    store.set(FOLDER_ENTRY, &serde_json::to_string(&folder).unwrap()).unwrap();
    let l = unselected(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    assert_eq!(l.activate(in_folder("", "ana@acme.com")).await.unwrap().state, State::Active);
    assert_eq!(bodies.lock().unwrap()[0]["key"], "BP-2HC6-FWG8-CR0K-VBDB");
    // Nothing stored anywhere: the key has to be typed.
    let l = unselected(MemStore::default(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT)));
    assert_eq!(l.activate(in_folder("", "ana@acme.com")).await.unwrap_err().message, "Enter the licence key.");
}

#[tokio::test]
async fn swapping_to_another_licences_key_gives_the_old_seat_back() {
    // Solo in the workspace, then its Team key: the Solo seat goes back after the Team one is taken.
    let team = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let (url, seen) = canned(vec![(200, ok_answer(&team)), (200, json!({ "ok": true, "released": true }))]).await;
    let store = MemStore::default();
    let mut solo = stored(Some(solo_token("acme-breakpatch")));
    solo.key = "BP-SOLO".into();
    put(&store, &solo);
    let l = licensing(store.clone(), &url, Arc::new(AtomicI64::new(IAT + 1)));
    let st = l.activate(person("BP-TEAM", "ana@acme.com")).await.unwrap();
    assert_eq!((st.tier.as_deref(), st.licence_id.as_deref()), (Some("team"), Some("L1")));
    assert_eq!(seen.lock().unwrap().as_slice(), ["/activate", "/release"]);
    assert_eq!(entry_of(&store, ENTRY).key, "BP-TEAM");
}

#[tokio::test]
async fn a_new_key_for_the_same_licence_keeps_its_seat() {
    let token = sign("test-rfc8032", &payload("acme-breakpatch", IAT));
    let (url, seen) = canned(vec![(200, ok_answer(&token))]).await;
    let store = MemStore::default();
    put(&store, &stored(Some(token.clone())));
    let l = licensing(store, &url, Arc::new(AtomicI64::new(IAT + 1)));
    l.activate(person("BP-REISSUED", "ana@acme.com")).await.unwrap();
    assert_eq!(seen.lock().unwrap().as_slice(), ["/activate"]);
}

#[tokio::test]
async fn without_a_device_id_a_folder_cant_activate() {
    #[derive(Clone)]
    struct Broken;
    impl SecretStore for Broken {
        fn get(&self, _: &str) -> Result<Option<String>, String> {
            Err("locked".into())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), String> {
            Err("locked".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    let l = Licensing::new(Broken, keys("test-rfc8032"), "http://127.0.0.1:9".into(), Box::new(|| ("m".into(), None)))
        .with_hardware(Box::new(|| None));
    assert_eq!(l.activate(in_folder("BP-K", "sam@initech.com")).await.unwrap_err().code, "no_device");
}

#[tokio::test]
async fn solo_is_told_by_the_code_and_tier_never_by_the_words() {
    // A Team refusal whose words happen to say "Solo" stays Team's.
    let (url, _) = canned(vec![(409, json!({ "ok": false, "error": { "code": "out_of_seats", "message": "Solo-ish words", "tier": "team" } }))]).await;
    let l = licensing(MemStore::default(), &url, Arc::new(AtomicI64::new(IAT)));
    let f = l.activate(person("BP-K", "bo@acme.com")).await.unwrap_err();
    assert_eq!((f.code.as_str(), f.tier.as_deref()), ("out_of_seats", None));
    assert_eq!(f.message, message_for("out_of_seats", None));
    // tier "solo" on a plain code: Solo's words.
    let (url, _) = canned(vec![(409, json!({ "ok": false, "error": { "code": "out_of_seats", "message": "x", "tier": "solo" } }))]).await;
    let l = licensing(MemStore::default(), &url, Arc::new(AtomicI64::new(IAT)));
    let f = l.activate(person("BP-K", "bo@acme.com")).await.unwrap_err();
    assert_eq!(f.tier.as_deref(), Some("solo"));
    assert!(f.message.contains("Solo is for one person"));
    // A Solo refusal the app has no words for (solo_needs_update): the service's.
    let (url, _) = canned(vec![(400, json!({ "ok": false, "error": { "code": "solo_needs_update", "message": "Update Breakpatch to use a Solo licence.", "tier": "solo" } }))]).await;
    let l = licensing(MemStore::default(), &url, Arc::new(AtomicI64::new(IAT)));
    let f = l.activate(person("BP-K", "bo@acme.com")).await.unwrap_err();
    assert_eq!((f.code.as_str(), f.message.as_str()), ("needs_update", "Update Breakpatch to use a Solo licence."));
}

#[tokio::test]
async fn a_recovery_code_or_machine_key_typed_as_a_licence_key_is_never_sent() {
    // Nothing listens there: a call would answer "offline".
    let l = licensing(MemStore::default(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT)));
    for k in ["BPR1-50M6-HA79-55MT-KTHA-DANE-PAVB-NFH", "bpr1 50m6 ha79 55mt ktha dane pavb nfh", "bpmk1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] {
        let f = l.activate(person(k, "bo@acme.com")).await.unwrap_err();
        assert_eq!(f.code, "bad_request", "{k}");
        assert!(f.message.contains("recovery code") || f.message.contains("machine key"), "{k}: {}", f.message);
    }
    // A licence key that happens to start with BP-R1 is one.
    assert_eq!(not_a_licence_key("BP-R1AB-CDEF-GH12-3456"), None);
    assert_eq!(not_a_licence_key("BPM1-0123456789abcdef0123456789abcdef-00"), None, "the machine pass is a licence credential");
}

#[tokio::test]
async fn a_runner_or_ci_token_typed_as_a_licence_key_says_which_it_is_and_is_never_sent() {
    let l = licensing(MemStore::default(), "http://127.0.0.1:9", Arc::new(AtomicI64::new(IAT)));
    let token = |p: &str| format!("{p}-{}-{}-{}", "k3v9x2m8q1w7e4r6t0y5u2i8o3p1", "m".repeat(16), "c".repeat(64));
    let pass = format!("BPM1-{}-{}", "0a".repeat(16), "1b".repeat(32));
    // A CI token (BPC1-): its own words, which name the runner's machine pass.
    let f = l.activate(person(&token("BPC1"), "bo@acme.com")).await.unwrap_err();
    assert_eq!(f.code, "bad_request");
    assert!(f.message.starts_with("That's a CI token (BPC1-…), for breakpatch-ci. It isn't a licence key: the runner Mac takes its seat with its machine pass, which starts with BPM1-"), "{}", f.message);
    let f = l.activate(person(&token("BPM1"), "bo@acme.com")).await.unwrap_err();
    assert!(f.message.starts_with("That's a runner token (BPM1-…)"), "{}", f.message);
    // Told apart however much of the paste a field kept; the pass itself goes through.
    assert_eq!(machine_secret(&token("BPC1")[..30]), Some(MachineSecret::CiToken));
    assert_eq!(machine_secret(&token("BPM1")[..30]), Some(MachineSecret::RunnerToken));
    assert_eq!(machine_secret(&pass[..30]), Some(MachineSecret::MachinePass));
    assert_eq!(machine_secret(&pass.to_lowercase()), Some(MachineSecret::MachinePass));
    assert_eq!(machine_secret("BP-2HC6-FWG8-CR0K-VBDB"), None);
    assert_eq!(not_a_licence_key(&pass), None);
}

/// The BPM1-/BPC1- cases the Team app (lib/secretShapes.ts) and breakpatch-ci (secret_shapes.py)
/// check too, from a copy of this file in the Team repo (fixtures/secret-shapes-v1.json).
#[test]
fn machine_secrets_are_told_apart_as_the_team_app_and_breakpatch_ci_do() {
    let v: serde_json::Value = serde_json::from_str(include_str!("testdata/secret-shapes-v1.json")).unwrap();
    let cases = v["cases"].as_array().unwrap();
    assert!(cases.len() > 10);
    for c in cases {
        let want = match c["shape"].as_str().unwrap() {
            "machinePass" => MachineSecret::MachinePass,
            "machineToken" => MachineSecret::RunnerToken,
            "ciToken" => MachineSecret::CiToken,
            other => panic!("unknown shape {other}"),
        };
        assert_eq!(machine_secret(c["text"].as_str().unwrap()), Some(want), "{}", c["why"]);
    }
}

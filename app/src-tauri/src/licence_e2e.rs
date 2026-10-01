//! End to end against the licence service on the Firebase emulators, signing with the RFC 8032
//! test key under kid `test-rfc8032`. Ignored by default; the Team back office runs it with
//! `npm run test:app-licence` (backoffice/scripts/licence-e2e.sh), which starts the emulators,
//! creates a licence with 1 seat and 1 machine and passes:
//!
//!   BP_LICENCE_URL   the functions emulator, e.g. http://127.0.0.1:5001/demo-breakpatch-backoffice/europe-west2
//!   BP_E2E_KEY       that licence's key
//!
//!   cargo test licence::e2e -- --ignored --nocapture

use super::*;
use std::collections::HashMap;
use std::sync::Arc;

const TEST_KEYS: &str = r#"{"test-rfc8032":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"}"#;

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

/// The workspace the installs have open (licence.rs `wsKey`).
const WS: &str = "team:acme-breakpatch/breakpatch";

/// One install of the app: its own Keychain and machine id, with the workspace open.
fn device(machine: &'static str) -> Licensing<MemStore> {
    let l = Licensing::new(
        MemStore::default(),
        KeyTable::parse(TEST_KEYS).unwrap(),
        service_url(),
        Box::new(move || (machine.into(), Some(format!("{machine} name")))),
    );
    l.select(Some(WS), Some("acme-breakpatch")).unwrap();
    l
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

fn machine(key: &str) -> ActivateRequest {
    ActivateRequest {
        ws_key: None,
        key: key.into(),
        key_from: None,
        workspace_project_id: "acme-breakpatch".into(),
        subject: None,
        kind: "machine".into(),
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the back office emulators: npm run test:app-licence in backoffice/"]
async fn activate_refresh_release_and_out_of_seats() {
    let key = std::env::var("BP_E2E_KEY").expect("BP_E2E_KEY: a licence key with 1 seat and 1 machine");
    assert!(std::env::var("BP_LICENCE_URL").is_ok(), "BP_LICENCE_URL: the functions emulator");
    println!("service: {}", service_url());

    // Ana's Mac takes the only seat. It counts usage too (usage.rs).
    let usage = Arc::new(crate::usage::UsageStore::new(None, crate::usage::Edition::Team, false));
    let ana = device("mac-ana").with_usage(Arc::clone(&usage));
    let st = ana.activate(person(&key, "ana@acme.com")).await.expect("activate ana");
    println!("ana activate: {:?} seats {:?}/{:?} tier {:?}", st.state, st.seats_used, st.seats, st.tier);
    assert_eq!(st.state, State::Active);
    assert_eq!((st.seats, st.seats_used), (Some(1), Some(1)));
    assert_eq!(st.workspace_project_id.as_deref(), Some("acme-breakpatch"));
    assert!(st.features.iter().any(|f| f == "collaboration"));
    let first_exp = st.expires_at.unwrap();

    // Refresh gets a new token for the same seat, and takes the usage counts with it.
    use crate::usage::{Event, Source};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    usage.record(Event::TestCreated, now, Some(WS));
    usage.record(Event::Run { source: Source::Manual, passed: true }, now, Some(WS));
    usage.record(Event::Run { source: Source::Schedule, passed: false }, now, Some(WS));
    tokio::time::sleep(Duration::from_millis(1100)).await;
    let st = ana.refresh().await;
    println!("ana refresh: {:?} exp {:?} (was {first_exp})", st.state, st.expires_at);
    assert_eq!(st.state, State::Active);
    assert!(st.expires_at.unwrap() > first_exp);
    assert_eq!(usage.pending_team(WS), None, "the service took the usage counts");

    // Activating again as the same person reuses the seat.
    assert_eq!(ana.activate(person(&key, "ana@acme.com")).await.expect("reuse").seats_used, Some(1));

    // Bo, on another Mac: out of seats.
    let bo = device("mac-bo");
    let f = bo.activate(person(&key, "bo@acme.com")).await.unwrap_err();
    println!("bo activate: {} ({})", f.code, f.message);
    assert_eq!(f.code, "out_of_seats");
    assert_eq!(f.message, "Your team is out of seats. Ask your admin to add one.");
    let st = bo.status(Some("acme-breakpatch"));
    assert_eq!((st.state, st.code.as_deref()), (State::None, Some("out_of_seats")));
    assert!(st.features.is_empty());

    // Ana releases; Bo gets the seat.
    let st = ana.release(None).await;
    println!("ana release: {:?}", st.state);
    assert_eq!(st.state, State::None);
    let st = bo.activate(person(&key, "bo@acme.com")).await.expect("bo after release");
    println!("bo activate after release: {:?} seats {:?}/{:?}", st.state, st.seats_used, st.seats);
    assert_eq!((st.state, st.seats_used), (State::Active, Some(1)));

    // Ana's refresh after her release has nothing to refresh.
    assert_eq!(ana.refresh().await.state, State::None);

    // Machines count separately from people: the runner Mac gets the one machine licence.
    let runner = device("runner-1");
    let st = runner.activate(machine(&key)).await.expect("runner machine");
    println!("runner activate: {:?} kind {:?} machines {:?}/{:?}", st.state, st.kind, st.machines_used, st.machines);
    assert_eq!((st.state, st.kind, st.machines_used), (State::Active, Some(Kind::Machine), Some(1)));
    let f = device("runner-2").activate(machine(&key)).await.unwrap_err();
    println!("second runner: {}", f.code);
    assert_eq!(f.code, "out_of_machines");

    // An unknown key.
    let f = device("mac-cy").activate(person("BP-0000-0000-0000-0000", "cy@acme.com")).await.unwrap_err();
    println!("unknown key: {}", f.code);
    assert_eq!(f.code, "unknown_key");

    // Tidy up.
    assert_eq!(bo.release(None).await.state, State::None);
    assert_eq!(runner.release(None).await.state, State::None);
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs the back office emulators: npm run test:app-licence in backoffice/"]
async fn community_usage_ping() {
    use crate::usage::{send_community, Edition, Event, Outcome, Source, UsageStore};
    let u = UsageStore::new(None, Edition::Community, false);
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    u.record(Event::TestCreated, now, None);
    u.record(Event::Run { source: Source::Manual, passed: true }, now, None);
    assert_eq!(
        send_community(&u, &reqwest::Client::new(), &service_url(), now).await,
        Outcome::Nothing,
        "not before the notice"
    );
    u.notice_seen();
    assert_eq!(send_community(&u, &reqwest::Client::new(), &service_url(), now).await, Outcome::Sent);
    assert_eq!(send_community(&u, &reqwest::Client::new(), &service_url(), now).await, Outcome::Nothing, "once a day");
    assert_eq!(u.settings(None).pending["testsCreated"], 0);
}

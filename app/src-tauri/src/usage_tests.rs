//! Unit tests for usage.rs: the counters, what is sent, and the Community ping.

use super::*;
use std::sync::{Arc, Mutex as StdMutex};

/// 2026-09-25 12:00 UTC, a Friday in ISO week 2026-W39.
const NOW: i64 = 1_790_337_600;
/// The Team workspace open (licence.rs `wsKey`).
const WS: &str = "team:acme-breakpatch/breakpatch";

fn run(source: Source, passed: bool) -> Event {
    Event::Run { source, passed }
}

fn team() -> UsageStore {
    UsageStore::new(None, Edition::Team, false)
}

fn community() -> UsageStore {
    UsageStore::new(None, Edition::Community, false).with_version("0.4.0")
}

#[test]
fn dates_are_utc_days_iso_weeks_and_months() {
    assert_eq!(civil(0), (1970, 1, 1));
    assert_eq!(civil(NOW / DAY), (2026, 9, 25));
    assert_eq!(days_from_civil(2026, 9, 25), NOW / DAY);
    assert_eq!(iso_week(NOW / DAY), (2026, 39));
    assert_eq!(iso_week(days_from_civil(2027, 1, 1)), (2026, 53));
    assert_eq!(iso_week(days_from_civil(2024, 12, 30)), (2025, 1));
    assert_eq!(iso_week(days_from_civil(2026, 9, 27)), (2026, 39)); // Sunday
    assert_eq!(iso_week(days_from_civil(2026, 9, 28)), (2026, 40)); // Monday
    assert_eq!(month(days_from_civil(2026, 9, 30)), (2026, 9));
    for d in -1000..3000 {
        let (y, m, dd) = civil(d);
        assert_eq!(days_from_civil(y, m, dd), d);
    }
}

#[test]
fn team_counts_tests_and_runs_by_source_only_with_a_licence() {
    let u = team();
    u.record(Event::TestCreated, NOW, None);
    assert_eq!(u.pending_team(WS), None, "nothing is counted without a licence");
    u.record(Event::TestCreated, NOW, Some(WS));
    u.record(run(Source::Manual, true), NOW, Some(WS));
    u.record(run(Source::Schedule, false), NOW, Some(WS));
    u.record(run(Source::Runner, true), NOW + DAY, Some(WS));
    u.record(run(Source::Ci, true), NOW + DAY, Some(WS));
    let c = u.pending_team(WS).unwrap();
    assert_eq!(
        c.team_payload(),
        json!({ "testsCreated": 1, "runs": { "manual": 1, "schedule": 1, "runner": 1, "ci": 1 }, "runsPassed": 3, "runsFailed": 1, "activeDays": 2 })
    );
}

#[test]
fn the_payload_is_numbers_only() {
    let u = team();
    u.record(Event::TestCreated, NOW, Some(WS));
    let p = u.pending_team(WS).unwrap().team_payload();
    let keys: Vec<&str> = p.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["activeDays", "runs", "runsFailed", "runsPassed", "testsCreated"]);
    fn all_numbers(v: &Value) -> bool {
        match v {
            Value::Number(_) => true,
            Value::Object(m) => m.values().all(all_numbers),
            _ => false,
        }
    }
    assert!(all_numbers(&p));
}

#[test]
fn reported_takes_off_what_was_sent_and_keeps_what_came_after() {
    let u = team();
    u.record(Event::TestCreated, NOW, Some(WS));
    u.record(run(Source::Manual, true), NOW, Some(WS));
    let sent = u.pending_team(WS).unwrap();
    // While the refresh is on its way:
    u.record(run(Source::Manual, false), NOW, Some(WS));
    u.reported(WS, &sent, NOW);
    let left = u.pending_team(WS).unwrap();
    assert_eq!((left.tests_created, left.runs.manual, left.runs_passed, left.runs_failed), (0, 1, 0, 1));
    // Today was already sent: it isn't counted again.
    assert!(left.days.is_empty());
    assert_eq!(left.team_payload()["activeDays"], 0);
    // Tomorrow is.
    u.record(Event::TestCreated, NOW + DAY, Some(WS));
    assert_eq!(u.pending_team(WS).unwrap().team_payload()["activeDays"], 1);
    let all = u.pending_team(WS).unwrap();
    u.reported(WS, &all, NOW + DAY);
    assert_eq!(u.pending_team(WS), None);
}

#[test]
fn counters_stop_at_the_local_cap() {
    let u = team();
    u.state.lock().unwrap().buckets.entry(WS.into()).or_default().counts.runs.ci = LOCAL_CAP;
    u.record(run(Source::Ci, true), NOW, Some(WS));
    assert_eq!(u.pending_team(WS).unwrap().runs.ci, LOCAL_CAP);
}

#[test]
fn counts_survive_a_restart_in_usage_json() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.json");
    let u = UsageStore::new(Some(path.clone()), Edition::Team, false);
    u.record(Event::TestCreated, NOW, Some(WS));
    u.record(run(Source::Runner, false), NOW, Some(WS));
    let again = UsageStore::new(Some(path.clone()), Edition::Team, false);
    let c = again.pending_team(WS).unwrap();
    assert_eq!((c.tests_created, c.runs.runner, c.runs_failed), (1, 1, 1));
    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.contains("\"v\":2"));
    // A broken file starts empty rather than failing.
    std::fs::write(&path, "{not json").unwrap();
    assert_eq!(UsageStore::new(Some(path), Edition::Team, false).pending_team(WS), None);
}

#[test]
fn community_sends_nothing_before_the_notice() {
    let u = community();
    u.record(Event::TestCreated, NOW, None);
    assert_eq!(u.community_ping(NOW), None);
    assert!(!u.settings(None).notice_seen);
    u.notice_seen();
    assert!(u.community_ping(NOW).is_some());
}

#[test]
fn community_pings_once_a_day_with_counts_and_no_identifier() {
    let u = community();
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    u.record(run(Source::Manual, true), NOW, None);
    u.record(run(Source::Manual, false), NOW, None);
    // Community has no runner, schedules or CI: those aren't counted.
    u.record(run(Source::Runner, true), NOW, None);
    let p = u.community_ping(NOW).unwrap();
    assert_eq!(
        p.body,
        json!({
            "edition": "community", "appVersion": "0.4.0",
            "usage": { "testsCreated": 1, "runs": { "manual": 2 }, "runsPassed": 1, "runsFailed": 1 },
            "firstToday": true, "firstThisWeek": true, "firstThisMonth": true, "newInstall": true,
        })
    );
    u.community_sent(&p);
    assert_eq!(u.community_ping(NOW + 3600), None, "one ping a day");
    // What's stored is the counts and the last-sent day, nothing else.
    let f = u.state.lock().unwrap().clone();
    assert_eq!(f.community.last_sent_day, Some(NOW / DAY));
    assert!(f.counts.is_empty());
}

#[test]
fn every_day_the_app_is_used_gets_a_ping_even_with_nothing_to_count() {
    let u = community();
    u.notice_seen();
    let first = u.community_ping(NOW).unwrap();
    u.community_sent(&first);
    // Saturday, same week and month.
    let p = u.community_ping(NOW + DAY).unwrap();
    assert_eq!(
        p.body["usage"],
        json!({ "testsCreated": 0, "runs": { "manual": 0 }, "runsPassed": 0, "runsFailed": 0 })
    );
    assert_eq!(
        (
            p.body["firstToday"].as_bool(),
            p.body["firstThisWeek"].as_bool(),
            p.body["firstThisMonth"].as_bool(),
            p.body["newInstall"].as_bool()
        ),
        (Some(true), Some(false), Some(false), Some(false))
    );
    u.community_sent(&p);
    // Monday 28 Sep: a new week, same month.
    let p = u.community_ping(NOW + 3 * DAY).unwrap();
    assert_eq!((p.body["firstThisWeek"].as_bool(), p.body["firstThisMonth"].as_bool()), (Some(true), Some(false)));
    u.community_sent(&p);
    // Thursday 1 Oct: same week, a new month.
    let p = u.community_ping(NOW + 6 * DAY).unwrap();
    assert_eq!(
        (p.body["firstThisWeek"].as_bool(), p.body["firstThisMonth"].as_bool(), p.body["newInstall"].as_bool()),
        (Some(false), Some(true), Some(false))
    );
}

#[test]
fn a_ping_carries_at_most_the_caps_and_the_rest_waits() {
    let u = community();
    u.notice_seen();
    {
        let mut f = u.state.lock().unwrap();
        f.counts.tests_created = PING_CAP_TESTS + 20;
        f.counts.runs.manual = PING_CAP_RUNS + 10;
        f.counts.runs_passed = PING_CAP_RUNS + 10;
    }
    let p = u.community_ping(NOW).unwrap();
    assert_eq!(p.body["usage"]["testsCreated"], PING_CAP_TESTS);
    assert_eq!(p.body["usage"]["runs"]["manual"], PING_CAP_RUNS);
    assert_eq!(p.body["usage"]["runsPassed"], PING_CAP_RUNS);
    u.community_sent(&p);
    let f = u.state.lock().unwrap().clone();
    assert_eq!((f.counts.tests_created, f.counts.runs.manual, f.counts.runs_passed), (20, 10, 10));
}

#[test]
fn turning_it_off_drops_what_is_waiting_and_stops_counting_and_sending() {
    let u = community();
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    let s = u.set_enabled(false);
    assert!(!s.enabled);
    assert_eq!(s.pending["testsCreated"], 0);
    u.record(Event::TestCreated, NOW, None);
    assert_eq!(u.community_ping(NOW), None);
    assert!(u.state.lock().unwrap().counts.is_empty());
    // On again: counting starts from nothing.
    u.set_enabled(true);
    u.record(run(Source::Manual, true), NOW, None);
    assert_eq!(u.community_ping(NOW).unwrap().body["usage"]["testsCreated"], 0);
}

#[test]
fn breakpatch_no_usage_turns_it_off_whatever_the_setting() {
    let u = UsageStore::new(None, Edition::Community, true);
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    assert_eq!(u.community_ping(NOW), None);
    let s = u.settings(None);
    assert!(!s.enabled && s.turned_off_by_env);
}

#[test]
fn the_env_switch_reads_like_a_flag() {
    for (v, off) in [("1", true), ("true", true), ("yes", true), ("0", false), ("false", false), ("", false)] {
        std::env::set_var("BREAKPATCH_NO_USAGE", v);
        assert_eq!(env_off(), off, "{v:?}");
    }
    std::env::remove_var("BREAKPATCH_NO_USAGE");
    assert!(!env_off());
}

#[test]
fn team_builds_never_ping_and_community_builds_never_refresh_with_usage() {
    let t = team();
    t.notice_seen();
    t.record(Event::TestCreated, NOW, Some(WS));
    assert_eq!(t.community_ping(NOW), None);
    let c = community();
    c.notice_seen();
    c.record(Event::TestCreated, NOW, Some(WS));
    assert_eq!(c.pending_team(WS), None);
}

#[test]
fn settings_show_exactly_what_would_be_sent() {
    let u = community();
    u.record(Event::TestCreated, NOW, None);
    let s = u.settings(None);
    assert_eq!(s.edition, "community");
    assert!(s.enabled && !s.notice_seen && !s.turned_off_by_env);
    assert_eq!(s.pending, json!({ "testsCreated": 1, "runs": { "manual": 0 }, "runsPassed": 0, "runsFailed": 0 }));
    let v = serde_json::to_value(&s).unwrap();
    assert!(v.get("turnedOffByEnv").is_some() && v.get("noticeSeen").is_some());
}

// ---- Sending ----

/// A one-shot local server: answers with `status` and `body`, and keeps the request body.
async fn server(status: u16, body: Value) -> (String, Arc<StdMutex<Vec<Value>>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api", listener.local_addr().unwrap());
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        let Ok((mut sock, _)) = listener.accept().await else { return };
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = sock.read(&mut chunk).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
            let text = String::from_utf8_lossy(&buf).to_string();
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
                    assert!(text.starts_with("POST /api/usage "), "{text}");
                    log.lock().unwrap().push(serde_json::from_str(&text[end + 4..]).unwrap_or(Value::Null));
                    break;
                }
            }
        }
        let body = body.to_string();
        let resp = format!("HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        let _ = sock.write_all(resp.as_bytes()).await;
        let _ = sock.shutdown().await;
    });
    (url, seen)
}

#[tokio::test]
async fn a_ping_the_service_takes_is_cleared() {
    let u = community();
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    let (url, seen) = server(200, json!({ "ok": true, "accepted": true })).await;
    assert_eq!(send_community(&u, &reqwest::Client::new(), &url, NOW).await, Outcome::Sent);
    assert_eq!(seen.lock().unwrap()[0]["usage"]["testsCreated"], 1);
    assert!(u.state.lock().unwrap().counts.is_empty());
    assert_eq!(send_community(&u, &reqwest::Client::new(), &url, NOW).await, Outcome::Nothing);
}

#[tokio::test]
async fn offline_or_rate_limited_keeps_the_counts_for_later() {
    let u = community();
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    assert_eq!(send_community(&u, &reqwest::Client::new(), "http://127.0.0.1:9", NOW).await, Outcome::Later);
    let (url, _) = server(429, json!({ "ok": false, "error": { "code": "rate_limited" } })).await;
    assert_eq!(send_community(&u, &reqwest::Client::new(), &url, NOW).await, Outcome::Later);
    assert_eq!(u.state.lock().unwrap().counts.tests_created, 1);
    assert_eq!(u.state.lock().unwrap().community.last_sent_day, None);
}

#[tokio::test]
async fn a_refused_ping_is_dropped_not_repeated() {
    let u = community();
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    let (url, _) = server(400, json!({ "ok": false, "error": { "code": "bad_request" } })).await;
    assert_eq!(send_community(&u, &reqwest::Client::new(), &url, NOW).await, Outcome::Dropped);
    assert_eq!(u.community_ping(NOW), None);
}

// ---- Per workspace (Team) ----

#[test]
fn each_workspace_counts_in_its_own_bucket() {
    let u = team();
    u.record(Event::TestCreated, NOW, Some(WS));
    u.record(run(Source::Manual, true), NOW, Some("team:globex/breakpatch"));
    u.record(run(Source::Manual, false), NOW, Some("team:globex/breakpatch"));
    assert_eq!(u.pending_team(WS).unwrap().tests_created, 1);
    assert_eq!(u.pending_team(WS).unwrap().runs.manual, 0);
    let other = u.pending_team("team:globex/breakpatch").unwrap();
    assert_eq!((other.tests_created, other.runs.manual), (0, 2));
    // One workspace's report leaves the other's waiting.
    let sent = u.pending_team(WS).unwrap();
    u.reported(WS, &sent, NOW);
    assert_eq!(u.pending_team(WS), None);
    assert_eq!(u.pending_team("team:globex/breakpatch").unwrap().runs.manual, 2);
    assert_eq!(u.settings(Some("team:globex/breakpatch")).pending["runs"]["manual"], 2);
    assert_eq!(u.settings(Some(WS)).pending["testsCreated"], 0);
}

#[test]
fn counts_from_before_buckets_move_to_one_workspace_and_are_sent_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("usage.json");
    // A version 1 file, as the app before per-workspace usage wrote it.
    std::fs::write(&path, r#"{"v":1,"counts":{"testsCreated":3,"runs":{"manual":2},"runsPassed":2,"days":[20000]},"reportedDays":[19999],"community":{"enabled":true}}"#).unwrap();
    let u = UsageStore::new(Some(path.clone()), Edition::Team, false);
    assert_eq!(u.pending_team(WS), None, "not anyone's until adopted");
    u.record(Event::TestCreated, NOW, Some(WS));
    u.adopt_legacy(WS);
    u.adopt_legacy("team:globex/breakpatch");
    let c = u.pending_team(WS).unwrap();
    assert_eq!((c.tests_created, c.runs.manual, c.runs_passed), (4, 2, 2));
    assert!(c.days.contains(&20000));
    assert_eq!(u.pending_team("team:globex/breakpatch"), None);
    let saved: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["v"], 2);
    assert_eq!(saved["counts"]["testsCreated"], 0);
    assert_eq!(saved["buckets"][WS]["counts"]["testsCreated"], 4);
}

#[test]
fn community_keeps_its_single_count() {
    let u = community();
    u.notice_seen();
    u.record(Event::TestCreated, NOW, None);
    u.adopt_legacy(WS);
    assert_eq!(u.settings(None).pending["testsCreated"], 1);
    assert_eq!(u.pending_team(WS), None);
}

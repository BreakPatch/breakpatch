//! Usage counts (docs/manual.md "Privacy"). Only numbers: tests created, runs by where they ran,
//! passed and failed, and (Team) on how many days. Never test names, addresses, screenshots, steps
//! or anything else from a test.
//!
//! The counts since the last report the service took are kept in `usage.json` in the app data
//! folder (not the Keychain), with the few settings below.
//!
//! - **Team** (licence keys built in): one bucket per workspace (the licence's `wsKey`,
//!   licence.rs), counted only while this Mac holds that workspace's licence and sent with that
//!   licence's refresh as `usage`, so each licence reports its own. Cleared only when the answer
//!   says `usageAccepted`. Counts from before buckets (version 1 of the file) move to the
//!   workspace whose licence moves with them, or else go with the next refresh.
//! - **Community** (no keys): on unless turned off (Settings → Privacy, or `BREAKPATCH_NO_USAGE=1`).
//!   Nothing is sent before the one-time notice has been shown. Then, on each day the app is used,
//!   one ping to `/api/usage` with the counts since the last ping, the app version, and four
//!   booleans worked out here from the last-sent date: first ping today, this week, this month,
//!   and ever. There is no identifier of any kind; the last-sent date is the only thing stored
//!   for it. Turning it off drops what's waiting.
//!
//! Going back to an older version: an app from before buckets keeps its own top-level counts and
//! drops the `buckets` it doesn't know when it next saves, so Team counts it hadn't reported are
//! lost. Buckets of workspaces removed from this Mac aren't pruned either; they're small and go
//! with that licence's refresh if it's ever connected again.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The most one counter keeps before the service has taken it (a Mac offline for months).
pub const LOCAL_CAP: u64 = 1_000_000;
/// The most one Community ping carries; the rest waits for the next day (the service's caps).
pub const PING_CAP_TESTS: u64 = 500;
pub const PING_CAP_RUNS: u64 = 5_000;
/// Days already counted are remembered this long, so a day is counted once.
const REPORTED_DAYS_KEPT: i64 = 60;
/// 2: Team counts per workspace (`buckets`). The version isn't checked on read: a version 1 app
/// (after a downgrade) reads a version 2 file without complaint, ignores `buckets` and writes the
/// file back as version 1 on its next save, so Team counts not yet reported are lost. That's
/// accepted (numbers only, a few days' worth at most); see "Going back to an older version" above.
const FILE_VERSION: u32 = 2;
const DAY: i64 = 86_400;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Edition {
    Team,
    Community,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Manual,
    Schedule,
    Runner,
    Ci,
}

impl Source {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "manual" => Some(Self::Manual),
            "schedule" => Some(Self::Schedule),
            "runner" => Some(Self::Runner),
            "ci" => Some(Self::Ci),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    TestCreated,
    Run { source: Source, passed: bool },
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(default)]
pub struct Runs {
    pub manual: u64,
    pub schedule: u64,
    pub runner: u64,
    pub ci: u64,
}

impl Runs {
    fn total(&self) -> u64 {
        self.manual + self.schedule + self.runner + self.ci
    }
}

/// The counts since the last report the service took.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Counts {
    pub tests_created: u64,
    pub runs: Runs,
    pub runs_passed: u64,
    pub runs_failed: u64,
    /// Days (since 1970, UTC) with activity; only how many is sent.
    pub days: BTreeSet<i64>,
}

impl Counts {
    pub fn is_empty(&self) -> bool {
        self.tests_created == 0
            && self.runs.total() == 0
            && self.runs_passed == 0
            && self.runs_failed == 0
            && self.days.is_empty()
    }

    /// What goes with a Team licence refresh.
    pub fn team_payload(&self) -> Value {
        json!({
            "testsCreated": self.tests_created,
            "runs": { "manual": self.runs.manual, "schedule": self.runs.schedule, "runner": self.runs.runner, "ci": self.runs.ci },
            "runsPassed": self.runs_passed,
            "runsFailed": self.runs_failed,
            "activeDays": self.days.len(),
        })
    }

    /// The part of these counts one Community ping carries: manual runs only, within the caps.
    fn for_ping(&self) -> Counts {
        let runs = self.runs.manual.min(PING_CAP_RUNS);
        let passed = self.runs_passed.min(runs);
        Counts {
            tests_created: self.tests_created.min(PING_CAP_TESTS),
            runs: Runs { manual: runs, ..Runs::default() },
            runs_passed: passed,
            runs_failed: self.runs_failed.min(runs - passed),
            days: BTreeSet::new(),
        }
    }

    fn community_payload(&self) -> Value {
        json!({
            "testsCreated": self.tests_created,
            "runs": { "manual": self.runs.manual },
            "runsPassed": self.runs_passed,
            "runsFailed": self.runs_failed,
        })
    }

    fn subtract(&mut self, sent: &Counts) {
        self.tests_created = self.tests_created.saturating_sub(sent.tests_created);
        self.runs.manual = self.runs.manual.saturating_sub(sent.runs.manual);
        self.runs.schedule = self.runs.schedule.saturating_sub(sent.runs.schedule);
        self.runs.runner = self.runs.runner.saturating_sub(sent.runs.runner);
        self.runs.ci = self.runs.ci.saturating_sub(sent.runs.ci);
        self.runs_passed = self.runs_passed.saturating_sub(sent.runs_passed);
        self.runs_failed = self.runs_failed.saturating_sub(sent.runs_failed);
        for d in &sent.days {
            self.days.remove(d);
        }
    }
}

fn bump(n: &mut u64) {
    *n = (*n + 1).min(LOCAL_CAP);
}

fn default_true() -> bool {
    true
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Community {
    /// On unless the person turned it off.
    #[serde(default = "default_true")]
    enabled: bool,
    /// The one-time notice was shown; nothing is sent before.
    #[serde(default)]
    notice_seen: bool,
    /// The day (since 1970, UTC) of the last ping the service took. The only thing kept about pings.
    #[serde(default)]
    last_sent_day: Option<i64>,
}

impl Default for Community {
    fn default() -> Self {
        Self { enabled: true, notice_seen: false, last_sent_day: None }
    }
}

/// One Team workspace's counts since its licence's last report, and the days it already sent.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct Bucket {
    counts: Counts,
    reported_days: BTreeSet<i64>,
}

impl Bucket {
    fn record(&mut self, ev: Event, now: i64) {
        let c = &mut self.counts;
        match ev {
            Event::TestCreated => bump(&mut c.tests_created),
            Event::Run { source, passed } => {
                bump(match source {
                    Source::Manual => &mut c.runs.manual,
                    Source::Schedule => &mut c.runs.schedule,
                    Source::Runner => &mut c.runs.runner,
                    Source::Ci => &mut c.runs.ci,
                });
                bump(if passed { &mut c.runs_passed } else { &mut c.runs_failed });
            }
        }
        let day = now.div_euclid(DAY);
        if !self.reported_days.contains(&day) {
            self.counts.days.insert(day);
        }
    }

    fn reported(&mut self, sent: &Counts, now: i64) {
        self.counts.subtract(sent);
        self.reported_days.extend(sent.days.iter().copied());
        let oldest = now.div_euclid(DAY) - REPORTED_DAYS_KEPT;
        self.reported_days.retain(|d| *d >= oldest);
    }

    fn add(&mut self, other: Bucket) {
        let (c, o) = (&mut self.counts, other.counts);
        let add = |a: &mut u64, b: u64| *a = (*a + b).min(LOCAL_CAP);
        add(&mut c.tests_created, o.tests_created);
        add(&mut c.runs.manual, o.runs.manual);
        add(&mut c.runs.schedule, o.runs.schedule);
        add(&mut c.runs.runner, o.runs.runner);
        add(&mut c.runs.ci, o.runs.ci);
        add(&mut c.runs_passed, o.runs_passed);
        add(&mut c.runs_failed, o.runs_failed);
        c.days.extend(o.days.into_iter().filter(|d| !self.reported_days.contains(d)));
        self.reported_days.extend(other.reported_days);
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
struct File {
    v: u32,
    /// Community's counts; in Team, counts kept before buckets (version 1), until adopted.
    counts: Counts,
    /// Days already sent (Community never keeps any; Team before buckets).
    reported_days: BTreeSet<i64>,
    community: Community,
    /// Team: per workspace key (licence.rs `wsKey`).
    buckets: std::collections::BTreeMap<String, Bucket>,
}

/// What Settings → Privacy shows.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// "team" or "community": how this build reports (Team with the licence check).
    pub edition: &'static str,
    /// Community: sharing is on.
    pub enabled: bool,
    /// `BREAKPATCH_NO_USAGE` is set: off, whatever the setting says.
    pub turned_off_by_env: bool,
    /// Community: the one-time notice was shown.
    pub notice_seen: bool,
    /// Exactly what the next report would carry, for people to see.
    pub pending: Value,
}

/// A Community ping ready to send, and the counts to take off once the service has them.
#[derive(Debug, PartialEq)]
pub struct Ping {
    pub body: Value,
    pub sent: Counts,
    pub day: i64,
}

pub struct UsageStore {
    path: Option<PathBuf>,
    edition: Edition,
    env_off: bool,
    app_version: String,
    state: Mutex<File>,
}

/// `BREAKPATCH_NO_USAGE` set to anything but empty, 0 or false.
pub fn env_off() -> bool {
    std::env::var("BREAKPATCH_NO_USAGE")
        .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "" | "0" | "false" | "no"))
        .unwrap_or(false)
}

impl UsageStore {
    /// `path`: `usage.json` in the app data folder (None: in memory only, for tests).
    pub fn new(path: Option<PathBuf>, edition: Edition, env_off: bool) -> Self {
        let state = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<File>(&t).ok())
            .unwrap_or_default();
        Self { path, edition, env_off, app_version: env!("CARGO_PKG_VERSION").to_string(), state: Mutex::new(state) }
    }

    #[cfg(test)]
    pub fn with_version(mut self, v: &str) -> Self {
        self.app_version = v.into();
        self
    }

    pub fn edition(&self) -> Edition {
        self.edition
    }

    fn save(&self, f: &File) {
        let Some(path) = &self.path else { return };
        let mut f = f.clone();
        f.v = FILE_VERSION;
        let res = serde_json::to_string(&f).map_err(|e| e.to_string()).and_then(|text| {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, path).map_err(|e| e.to_string())
        });
        if let Err(e) = res {
            log::warn!("couldn't save the usage counts: {e}");
        }
    }

    fn community_on(&self, f: &File) -> bool {
        self.edition == Edition::Community && f.community.enabled && !self.env_off
    }

    /// Counts one thing that happened at `now` (Unix seconds). Team counts only while this Mac holds
    /// the licence of the workspace open (`licensed_ws`, its key), in that workspace's bucket;
    /// Community only while sharing is on. Community has manual runs only.
    pub fn record(&self, ev: Event, now: i64, licensed_ws: Option<&str>) {
        let mut f = self.state.lock().unwrap();
        match self.edition {
            Edition::Team => {
                let Some(ws) = licensed_ws else { return };
                f.buckets.entry(ws.to_string()).or_default().record(ev, now);
            }
            Edition::Community => {
                if !self.community_on(&f) || matches!(ev, Event::Run { source, .. } if source != Source::Manual) {
                    return;
                }
                let mut b = Bucket {
                    counts: std::mem::take(&mut f.counts),
                    reported_days: std::mem::take(&mut f.reported_days),
                };
                b.record(ev, now);
                (f.counts, f.reported_days) = (b.counts, b.reported_days);
            }
        }
        self.save(&f);
    }

    /// Team: counts kept before buckets go to `ws` (the workspace whose licence they were counted
    /// under, or the next one to refresh).
    pub fn adopt_legacy(&self, ws: &str) {
        if self.edition != Edition::Team {
            return;
        }
        let mut f = self.state.lock().unwrap();
        if f.counts.is_empty() && f.reported_days.is_empty() {
            return;
        }
        let old = Bucket { counts: std::mem::take(&mut f.counts), reported_days: std::mem::take(&mut f.reported_days) };
        f.buckets.entry(ws.to_string()).or_default().add(old);
        self.save(&f);
    }

    /// Team: this workspace's counts to send with its next refresh, or None when there's nothing.
    pub fn pending_team(&self, ws: &str) -> Option<Counts> {
        if self.edition != Edition::Team {
            return None;
        }
        let f = self.state.lock().unwrap();
        f.buckets.get(ws).map(|b| &b.counts).filter(|c| !c.is_empty()).cloned()
    }

    /// The service took `sent` for `ws`: take it off (anything counted meanwhile stays).
    pub fn reported(&self, ws: &str, sent: &Counts, now: i64) {
        let mut f = self.state.lock().unwrap();
        f.buckets.entry(ws.to_string()).or_default().reported(sent, now);
        if f.buckets.get(ws).is_some_and(|b| b.counts.is_empty() && b.reported_days.is_empty()) {
            f.buckets.remove(ws);
        }
        self.save(&f);
    }

    /// What Settings → Privacy shows. Team: the bucket of `ws`, the workspace open.
    pub fn settings(&self, ws: Option<&str>) -> Settings {
        let f = self.state.lock().unwrap();
        let pending = match self.edition {
            Edition::Team => ws
                .and_then(|w| f.buckets.get(w))
                .map(|b| b.counts.team_payload())
                .unwrap_or_else(|| Counts::default().team_payload()),
            Edition::Community if self.community_on(&f) => f.counts.for_ping().community_payload(),
            Edition::Community => Counts::default().community_payload(),
        };
        Settings {
            edition: if self.edition == Edition::Team { "team" } else { "community" },
            enabled: f.community.enabled && !self.env_off,
            turned_off_by_env: self.env_off,
            notice_seen: f.community.notice_seen,
            pending,
        }
    }

    /// Community: turn sharing on or off. Off drops what's waiting to be sent.
    pub fn set_enabled(&self, on: bool) -> Settings {
        {
            let mut f = self.state.lock().unwrap();
            f.community.enabled = on;
            f.community.notice_seen = true;
            if !on {
                f.counts = Counts::default();
                f.reported_days.clear();
            }
            self.save(&f);
        }
        self.settings(None)
    }

    /// Community: the one-time notice was shown (OK). Sending may start.
    pub fn notice_seen(&self) -> Settings {
        {
            let mut f = self.state.lock().unwrap();
            f.community.notice_seen = true;
            self.save(&f);
        }
        self.settings(None)
    }

    /// Community: today's ping, when one is due (sharing on, notice shown, none sent today yet).
    /// It goes even with nothing counted, so each day the app is used is counted.
    pub fn community_ping(&self, now: i64) -> Option<Ping> {
        let f = self.state.lock().unwrap();
        if !self.community_on(&f) || !f.community.notice_seen {
            return None;
        }
        let today = now.div_euclid(DAY);
        let last = f.community.last_sent_day;
        if last.is_some_and(|d| d >= today) {
            return None;
        }
        let sent = f.counts.for_ping();
        let new_install = last.is_none();
        let first_week = last.map_or(true, |d| iso_week(d) != iso_week(today));
        let first_month = last.map_or(true, |d| month(d) != month(today));
        let body = json!({
            "edition": "community",
            "appVersion": self.app_version,
            "usage": sent.community_payload(),
            "firstToday": true,
            "firstThisWeek": first_week,
            "firstThisMonth": first_month,
            "newInstall": new_install,
        });
        Some(Ping { body, sent, day: today })
    }

    /// The service took today's ping.
    pub fn community_sent(&self, ping: &Ping) {
        let mut f = self.state.lock().unwrap();
        f.counts.subtract(&ping.sent);
        // Days aren't sent from Community; keep none of them.
        f.counts.days.clear();
        f.community.last_sent_day = Some(ping.day);
        self.save(&f);
    }

    /// The service refused the ping as malformed: drop it, so it isn't sent again and again.
    fn community_dropped(&self, ping: &Ping) {
        self.community_sent(ping);
    }
}

// ---- Dates (UTC, from days since 1970) --------------------------------------------------------

/// (year, month, day) of a day since 1970 (proleptic Gregorian; Howard Hinnant's algorithm).
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// ISO 8601 (week-year, week) of a day since 1970.
fn iso_week(days: i64) -> (i64, i64) {
    let weekday = (days + 3).rem_euclid(7); // Monday 0 … Sunday 6 (1970-01-01 was a Thursday)
    let thursday = days - weekday + 3;
    let year = civil(thursday).0;
    (year, (thursday - days_from_civil(year, 1, 1)) / 7 + 1)
}

fn month(days: i64) -> (i64, u32) {
    let (y, m, _) = civil(days);
    (y, m)
}

// ---- Sending (Community) ------------------------------------------------------------------------

/// How often the app checks whether today's ping is due, and how long after launch it first does.
pub const CHECK_EVERY: Duration = Duration::from_secs(3600);
pub const FIRST_CHECK_AFTER: Duration = Duration::from_secs(60);

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Nothing,
    Sent,
    /// Offline, rate limited or the service is having trouble: try again at the next check.
    Later,
    Dropped,
}

/// Sends today's Community ping if one is due. `base` is the licence service's address
/// (licence::service_url()); the ping goes to `{base}/usage`.
pub async fn send_community(store: &UsageStore, client: &reqwest::Client, base: &str, now: i64) -> Outcome {
    let Some(ping) = store.community_ping(now) else { return Outcome::Nothing };
    let url = format!("{}/usage", base.trim_end_matches('/'));
    let res = match client.post(&url).json(&ping.body).send().await {
        Ok(r) => r,
        Err(e) => {
            log::info!("usage: couldn't reach the service ({})", e.without_url());
            return Outcome::Later;
        }
    };
    let status = res.status();
    let ok = res.json::<Value>().await.ok().and_then(|v| v.get("ok").and_then(Value::as_bool)) == Some(true);
    if ok {
        store.community_sent(&ping);
        Outcome::Sent
    } else if status.is_server_error() || status.as_u16() == 429 {
        Outcome::Later
    } else {
        log::info!("usage: the service refused the counts (HTTP {}); dropping them", status.as_u16());
        store.community_dropped(&ping);
        Outcome::Dropped
    }
}

#[cfg(test)]
#[path = "usage_tests.rs"]
mod tests;

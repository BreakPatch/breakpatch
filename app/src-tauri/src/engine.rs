//! The Python engine sidecar: JSON Lines over stdio (engine/PROTOCOL.md).
//!
//! `RequestTable` is the pure part (ids, pending map, line parsing) and is unit tested.
//! `EngineHost` owns the child process: it spawns `breakpatch-engine serve` once at
//! startup, restarts it with backoff if it dies, forwards events to the webview as
//! `engine://event` and stops it on exit. It also hands every engine process the licence token
//! (`licence.set`): on each start and restart, and whenever the licence changes (lib.rs).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::oneshot;

pub const EVENT_NAME: &str = "engine://event";

/// How long a request waits for an engine process to exist before failing with `not_ready`.
const START_WAIT: Duration = Duration::from_secs(10);

/// Error shape the UI expects (sidecarEngine.ts parses it from the rejected string).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineError {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: String,
}

impl EngineError {
    pub fn new(code: &str, message: &str, details: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into(), details: details.into() }
    }

    /// Reads the `error` object of a response, tolerating a missing or non-string field.
    fn from_wire(v: &Value) -> Self {
        let text = |k: &str| match v.get(k) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        };
        let code = text("code");
        let message = text("message");
        Self {
            code: if code.is_empty() { "internal".into() } else { code },
            message: if message.is_empty() { "Something went wrong in the engine.".into() } else { message },
            details: text("details"),
        }
    }

    pub fn to_json_string(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| self.message.clone())
    }
}

pub type Reply = Result<Value, EngineError>;

/// What one stdout line turned out to be.
#[derive(Debug, PartialEq)]
pub enum Line {
    /// A response; it was handed to the waiting request (`false` if nobody was waiting any more).
    Response { id: u64, delivered: bool },
    /// An event to forward to the webview.
    Event { event: String, data: Value },
    /// Not protocol output (a stray print, blank line). Logged, never forwarded.
    Other(String),
}

#[derive(Default)]
pub struct RequestTable {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
}

impl RequestTable {
    /// Reserves an id and returns the receiver its response will arrive on.
    pub fn register(&self) -> (u64, oneshot::Receiver<Reply>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }

    pub fn cancel(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }

    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        self.pending.lock().unwrap().len()
    }

    /// Fails every waiting request, e.g. when the engine process died.
    pub fn fail_all(&self, err: &EngineError) {
        let drained: Vec<_> = self.pending.lock().unwrap().drain().collect();
        for (_, tx) in drained {
            let _ = tx.send(Err(err.clone()));
        }
    }

    /// Parses one stdout line; responses resolve their pending request here.
    pub fn handle_line(&self, raw: &str) -> Line {
        let line = raw.trim();
        let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(line) else {
            return Line::Other(line.to_string());
        };
        if let Some(event) = obj.get("event").and_then(Value::as_str) {
            let data = obj.get("data").cloned().unwrap_or(Value::Null);
            return Line::Event { event: event.to_string(), data };
        }
        let Some(id) = obj.get("id").and_then(Value::as_u64) else {
            return Line::Other(line.to_string());
        };
        let reply = match obj.get("error") {
            Some(e) if !e.is_null() => Err(EngineError::from_wire(e)),
            _ => Ok(obj.get("result").cloned().unwrap_or(Value::Null)),
        };
        let tx = self.pending.lock().unwrap().remove(&id);
        let delivered = tx.map(|tx| tx.send(reply).is_ok()).unwrap_or(false);
        Line::Response { id, delivered }
    }

    /// Sends a request through `write` and waits for its response (or the timeout).
    pub async fn request<W>(&self, method: &str, params: Value, write: W) -> Reply
    where
        W: FnOnce(String) -> Result<(), EngineError>,
    {
        let (id, rx) = self.register();
        if let Err(e) = write(encode_request(id, method, &params)) {
            self.cancel(id);
            return Err(e);
        }
        let outcome = match timeout_for(method) {
            Some(limit) => match tokio::time::timeout(limit, rx).await {
                Ok(r) => r,
                Err(_) => {
                    self.cancel(id);
                    return Err(EngineError::new(
                        "internal",
                        "The engine took too long to answer. Try again.",
                        format!("{method} timed out after {}s", limit.as_secs()),
                    ));
                }
            },
            None => rx.await,
        };
        outcome.unwrap_or_else(|_| {
            Err(EngineError::new(
                "internal",
                "The engine stopped before it answered.",
                format!("{method}: response channel closed"),
            ))
        })
    }
}

pub fn encode_request(id: u64, method: &str, params: &Value) -> String {
    let params = if params.is_null() { json!({}) } else { params.clone() };
    let mut s = json!({ "id": id, "method": method, "params": params }).to_string();
    s.push('\n');
    s
}

/// Downloads and installs report progress through events and can take a long time, so
/// they have no timeout. Recording runs the automatic checks (and maybe the AI assistant).
pub fn timeout_for(method: &str) -> Option<Duration> {
    match method {
        "setup.installBrowser" | "setup.downloadModel" => None,
        "record.point" | "record.locate" | "record.checkpoint" | "browser.open" | "browser.navigate" => {
            Some(Duration::from_secs(180))
        }
        _ => Some(Duration::from_secs(60)),
    }
}

/// Methods the webview may send through `engine_request`. The licence is the shell's to hand over
/// (`EngineHost::set_licence`), so `licence.*` is refused from the UI. The engine checks any token
/// itself, so this keeps the shell the one source of it rather than guarding a secret.
pub fn forwardable(method: &str) -> bool {
    !method.starts_with("licence.")
}

/// The `licence.set` params for a token (null when there is none).
pub fn licence_params(token: Option<&str>) -> Value {
    json!({ "token": token })
}

/// Wait before restarting a crashed engine: 1, 2, 4 … 30 s, back to 1 s once it stayed up a minute.
pub fn restart_delay(failures: u32) -> Duration {
    Duration::from_secs((1u64 << failures.min(5)).min(30))
}

// ---------------------------------------------------------------------------------------
// Process management (needs a Tauri app).

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
pub struct EngineHost {
    pub table: RequestTable,
    child: Mutex<Option<CommandChild>>,
    shutting_down: AtomicBool,
    /// The licence token to hand the engine: None until the shell has read it (then nothing is
    /// sent), Some(None) when there is none.
    licence: Mutex<Option<Option<String>>>,
}

impl EngineHost {
    /// Starts the supervise loop: spawn, pump output, restart when it exits.
    pub fn start<R: Runtime>(self: &Arc<Self>, app: AppHandle<R>) {
        let host = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut failures = 0u32;
            while !host.shutting_down.load(Ordering::SeqCst) {
                let started = Instant::now();
                match app.shell().sidecar("breakpatch-engine").map(|c| c.args(["serve"])).and_then(|c| c.spawn()) {
                    Ok((rx, child)) => {
                        log::info!(target: "engine", "engine started (pid {})", child.pid());
                        *host.child.lock().unwrap() = Some(child);
                        host.push_licence();
                        host.pump(&app, rx).await;
                        host.child.lock().unwrap().take();
                        host.table.fail_all(&EngineError::new(
                            "internal",
                            "The engine stopped unexpectedly. It's restarting; try again in a moment.",
                            "engine process exited",
                        ));
                    }
                    Err(e) => log::error!(target: "engine", "couldn't start the engine: {e}"),
                }
                if host.shutting_down.load(Ordering::SeqCst) {
                    break;
                }
                failures = if started.elapsed() > Duration::from_secs(60) { 0 } else { failures + 1 };
                let wait = restart_delay(failures);
                log::warn!(target: "engine", "restarting the engine in {}s", wait.as_secs());
                tokio::time::sleep(wait).await;
            }
        });
    }

    async fn pump<R: Runtime>(&self, app: &AppHandle<R>, mut rx: tauri::async_runtime::Receiver<CommandEvent>) {
        while let Some(ev) = rx.recv().await {
            match ev {
                CommandEvent::Stdout(bytes) => match self.table.handle_line(&String::from_utf8_lossy(&bytes)) {
                    Line::Event { event, data } => {
                        if let Err(e) = app.emit(EVENT_NAME, json!({ "event": event, "data": data })) {
                            log::warn!(target: "engine", "couldn't forward {event}: {e}");
                        }
                    }
                    Line::Response { id, delivered: false } => {
                        log::debug!(target: "engine", "late response for request {id} dropped")
                    }
                    Line::Response { .. } => {}
                    Line::Other(s) if s.is_empty() => {}
                    Line::Other(s) => log::info!(target: "engine", "stdout: {}", truncate(&s, 500)),
                },
                CommandEvent::Stderr(bytes) => {
                    let s = String::from_utf8_lossy(&bytes);
                    let s = s.trim_end();
                    if !s.is_empty() {
                        log::info!(target: "engine", "{s}");
                    }
                }
                CommandEvent::Error(e) => log::error!(target: "engine", "{e}"),
                CommandEvent::Terminated(t) => {
                    log::warn!(target: "engine", "engine exited (code {:?}, signal {:?})", t.code, t.signal);
                    break;
                }
                _ => {}
            }
        }
    }

    /// Records the licence token and hands it to the running engine (a new one gets it when it
    /// starts). A run in progress keeps going; the engine applies the new state from its next step.
    pub fn set_licence(self: &Arc<Self>, token: Option<String>) {
        *self.licence.lock().unwrap() = Some(token);
        if self.child.lock().unwrap().is_some() {
            self.push_licence();
        }
    }

    fn push_licence(self: &Arc<Self>) {
        let Some(token) = self.licence.lock().unwrap().clone() else { return };
        let host = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // The token never goes to the log; the state the engine saw does.
            match host.request("licence.set", licence_params(token.as_deref())).await {
                Ok(v) => {
                    log::info!(target: "engine", "engine licence: {}", v.get("state").and_then(Value::as_str).unwrap_or("?"))
                }
                Err(e) => log::warn!(target: "engine", "couldn't hand the engine its licence: {}", e.message),
            }
        });
    }

    pub async fn request(&self, method: &str, params: Value) -> Reply {
        // The UI may ask before the first spawn finished or during a restart: wait a little
        // rather than failing straight away.
        let deadline = Instant::now() + START_WAIT;
        while self.child.lock().unwrap().is_none()
            && !self.shutting_down.load(Ordering::SeqCst)
            && Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        self.table
            .request(method, params, |line| {
                let mut guard = self.child.lock().unwrap();
                let child = guard.as_mut().ok_or_else(|| {
                    EngineError::new("not_ready", "The engine is starting. Try again in a moment.", "no engine process")
                })?;
                child
                    .write(line.as_bytes())
                    .map_err(|e| EngineError::new("internal", "Couldn't reach the engine.", e.to_string()))
            })
            .await
    }

    /// Asks the engine to quit, escalating if it doesn't. SIGINT first: the engine's
    /// `asyncio.run` turns it into a cancellation, so its `finally` closes Playwright and
    /// Chromium. SIGTERM would end Python without that cleanup, so it is only the fallback.
    pub fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let Some(child) = self.child.lock().unwrap().take() else { return };
        #[cfg(unix)]
        {
            let pid = child.pid() as libc::pid_t;
            for (signal, wait) in [(libc::SIGINT, Duration::from_secs(3)), (libc::SIGTERM, Duration::from_secs(1))] {
                // SAFETY: plain signal syscalls on our own child's pid.
                if unsafe { libc::kill(pid, signal) } != 0 || wait_for_exit(pid, wait) {
                    break;
                }
            }
        }
        let _ = child.kill();
        self.table.fail_all(&EngineError::new("stopped", "Breakpatch is quitting.", "app exit"));
    }
}

/// Polls until `pid` is gone (the shell plugin's waiter reaps it) or `limit` passes.
#[cfg(unix)]
fn wait_for_exit(pid: libc::pid_t, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    loop {
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn truncate(s: &str, max: usize) -> &str {
    match s.char_indices().nth(max) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_unique_and_increasing() {
        let t = RequestTable::default();
        let (a, _ra) = t.register();
        let (b, _rb) = t.register();
        assert_eq!((a, b), (1, 2));
        assert_eq!(t.pending_count(), 2);
    }

    #[test]
    fn encodes_one_line_with_empty_params_for_null() {
        let s = encode_request(7, "system.info", &Value::Null);
        assert!(s.ends_with('\n') && s.matches('\n').count() == 1);
        let v: Value = serde_json::from_str(s.trim()).unwrap();
        assert_eq!(v, json!({"id": 7, "method": "system.info", "params": {}}));
    }

    #[tokio::test]
    async fn result_resolves_the_matching_request() {
        let t = RequestTable::default();
        let (id, rx) = t.register();
        let (_other, _rx2) = t.register();
        let line = json!({"id": id, "result": {"ok": true}}).to_string();
        assert_eq!(t.handle_line(&line), Line::Response { id, delivered: true });
        assert_eq!(rx.await.unwrap(), Ok(json!({"ok": true})));
        assert_eq!(t.pending_count(), 1);
    }

    #[tokio::test]
    async fn error_passes_through_as_json_string() {
        let t = RequestTable::default();
        let (id, rx) = t.register();
        let line =
            json!({"id": id, "error": {"code": "not_found", "message": "Plain sentence", "details": "tb"}}).to_string();
        t.handle_line(&line);
        let err = rx.await.unwrap().unwrap_err();
        assert_eq!(err, EngineError::new("not_found", "Plain sentence", "tb"));
        let back: Value = serde_json::from_str(&err.to_json_string()).unwrap();
        assert_eq!(back, json!({"code": "not_found", "message": "Plain sentence", "details": "tb"}));
    }

    #[test]
    fn error_with_odd_fields_gets_defaults() {
        let e = EngineError::from_wire(&json!({"details": {"trace": [1]}}));
        assert_eq!(e.code, "internal");
        assert!(!e.message.is_empty());
        assert_eq!(e.details, r#"{"trace":[1]}"#);
    }

    #[test]
    fn events_and_noise_are_classified() {
        let t = RequestTable::default();
        assert_eq!(
            t.handle_line(r#"{"event":"frame","data":{"seq":3}}"#),
            Line::Event { event: "frame".into(), data: json!({"seq": 3}) }
        );
        assert_eq!(t.handle_line("  hello\n"), Line::Other("hello".into()));
        assert_eq!(t.handle_line(r#"{"nope":1}"#), Line::Other(r#"{"nope":1}"#.into()));
        assert_eq!(t.handle_line(r#"{"id":99,"result":{}}"#), Line::Response { id: 99, delivered: false });
    }

    #[tokio::test]
    async fn request_round_trip_through_writer() {
        let t = Arc::new(RequestTable::default());
        let t2 = Arc::clone(&t);
        let reply = t
            .request("system.info", Value::Null, move |line| {
                let v: Value = serde_json::from_str(line.trim()).unwrap();
                let id = v["id"].as_u64().unwrap();
                // Answer from "the engine" on another task, like the stdout pump does.
                tokio::spawn(async move {
                    t2.handle_line(&json!({"id": id, "result": {"memoryGb": 16}}).to_string());
                });
                Ok(())
            })
            .await;
        assert_eq!(reply, Ok(json!({"memoryGb": 16})));
        assert_eq!(t.pending_count(), 0);
    }

    #[tokio::test]
    async fn write_failure_cleans_up() {
        let t = RequestTable::default();
        let r = t.request("system.info", Value::Null, |_| Err(EngineError::new("not_ready", "x", ""))).await;
        assert_eq!(r.unwrap_err().code, "not_ready");
        assert_eq!(t.pending_count(), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn times_out_and_forgets_the_request() {
        let t = RequestTable::default();
        let r = t.request("run.stop", json!({"runId": "r1"}), |_| Ok(())).await;
        let e = r.unwrap_err();
        assert_eq!(e.code, "internal");
        assert!(e.details.contains("timed out"));
        assert_eq!(t.pending_count(), 0);
    }

    #[tokio::test]
    async fn fail_all_rejects_everyone() {
        let t = RequestTable::default();
        let (_, a) = t.register();
        let (_, b) = t.register();
        t.fail_all(&EngineError::new("internal", "gone", ""));
        assert_eq!(a.await.unwrap().unwrap_err().message, "gone");
        assert_eq!(b.await.unwrap().unwrap_err().message, "gone");
        assert_eq!(t.pending_count(), 0);
    }

    #[test]
    fn the_ui_cannot_set_the_licence() {
        assert!(forwardable("run.start") && forwardable("system.info"));
        assert!(!forwardable("licence.set") && !forwardable("licence.anything"));
    }

    #[test]
    fn licence_params_carry_the_token_or_null() {
        assert_eq!(licence_params(Some("a.b.c")), json!({"token": "a.b.c"}));
        assert_eq!(licence_params(None), json!({"token": null}));
        let line = encode_request(3, "licence.set", &licence_params(None));
        assert_eq!(serde_json::from_str::<Value>(line.trim()).unwrap()["params"], json!({"token": null}));
    }

    #[test]
    fn timeouts_and_backoff() {
        assert_eq!(timeout_for("setup.downloadModel"), None);
        assert_eq!(timeout_for("system.info"), Some(Duration::from_secs(60)));
        assert_eq!(restart_delay(0), Duration::from_secs(1));
        assert_eq!(restart_delay(3), Duration::from_secs(8));
        assert_eq!(restart_delay(20), Duration::from_secs(30));
    }

    /// Talks to the real Python engine through the sidecar in `binaries/` (the dev placeholder
    /// or a PyInstaller build) and checks it stops cleanly on SIGINT, as `shutdown` expects.
    /// Needs `engine/.venv`: `sh ../scripts/dev-sidecar.sh && cargo test -- --ignored`.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs the engine sidecar"]
    async fn real_engine_round_trip_and_sigint() {
        use std::io::{BufRead, BufReader, Write};
        use std::process::{Command, Stdio};

        let triple = env!("TAURI_ENV_TARGET_TRIPLE");
        let bin = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("binaries/breakpatch-engine-{triple}"));
        let mut child = Command::new(&bin)
            .arg("serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap_or_else(|e| panic!("couldn't start {}: {e}", bin.display()));
        let mut stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let table = Arc::new(RequestTable::default());
        let reader_table = Arc::clone(&table);
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                reader_table.handle_line(&line);
            }
        });
        let mut send = |line: String| {
            stdin.write_all(line.as_bytes()).map_err(|e| EngineError::new("internal", "", e.to_string()))
        };

        let info = table.request("system.info", Value::Null, &mut send).await.expect("system.info");
        assert!(info.get("engineVersion").is_some(), "unexpected system.info: {info}");
        let err = table.request("no.such.method", Value::Null, &mut send).await.unwrap_err();
        assert!(!err.code.is_empty() && !err.message.is_empty());
        assert_eq!(table.pending_count(), 0);

        // SAFETY: signalling our own child.
        unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGINT) };
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.code().is_some(), "engine was killed by a signal instead of exiting: {status}");
                break;
            }
            assert!(Instant::now() < deadline, "engine ignored SIGINT");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

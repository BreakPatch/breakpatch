//! Local runner helpers (spec §12.4): keep the Mac awake, open at login, memory size,
//! and posting result messages (kept out of the webview so the CSP stays strict).

use std::sync::Mutex;
use std::time::Duration;

use serde_json::Value;

/// Holds the `caffeinate` process while runner mode keeps the Mac awake.
#[derive(Default)]
pub struct KeepAwake {
    child: Mutex<Option<std::process::Child>>,
}

impl KeepAwake {
    pub fn set(&self, on: bool) -> Result<(), String> {
        let mut guard = self.child.lock().unwrap();
        if !on {
            if let Some(mut c) = guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            return Ok(());
        }
        if let Some(c) = guard.as_mut() {
            if matches!(c.try_wait(), Ok(None)) {
                return Ok(()); // already running
            }
        }
        *guard = spawn_caffeinate()?;
        Ok(())
    }

    #[cfg(test)]
    pub fn is_on(&self) -> bool {
        self.child.lock().unwrap().as_mut().is_some_and(|c| matches!(c.try_wait(), Ok(None)))
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        let _ = self.set(false);
    }
}

#[cfg(target_os = "macos")]
fn spawn_caffeinate() -> Result<Option<std::process::Child>, String> {
    // -d display, -i idle, -m disk, -s system (on AC), -u user active; -w ends it with us.
    std::process::Command::new("/usr/bin/caffeinate")
        .args(["-dimsu", "-w", &std::process::id().to_string()])
        .spawn()
        .map(Some)
        .map_err(|e| format!("Couldn't keep this Mac awake: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn spawn_caffeinate() -> Result<Option<std::process::Child>, String> {
    Ok(None)
}

/// Installed memory in whole GB (16 GB Mac → 16). 0 if unknown.
pub fn memory_gb() -> u32 {
    let bytes = memory_bytes().unwrap_or(0);
    ((bytes as f64) / (1u64 << 30) as f64).round() as u32
}

#[cfg(target_os = "macos")]
fn memory_bytes() -> Option<u64> {
    let mut value: u64 = 0;
    let mut size = std::mem::size_of::<u64>();
    // SAFETY: hw.memsize is a u64; buffer and size match.
    let rc = unsafe {
        libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut value as *mut u64).cast(), &mut size, std::ptr::null_mut(), 0)
    };
    (rc == 0).then_some(value)
}

#[cfg(target_os = "linux")]
fn memory_bytes() -> Option<u64> {
    parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory_bytes() -> Option<u64> {
    None
}

#[cfg_attr(not(any(test, target_os = "linux")), allow(dead_code))]
fn parse_meminfo(text: &str) -> Option<u64> {
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/// How long one try at posting a result message may take, connection included. The runner
/// retries on its side (3 tries over 5 minutes), so a slow address never holds a try longer.
pub const RESULT_TIMEOUT: Duration = Duration::from_secs(20);
const RESULT_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// Only https web addresses may receive result messages (they carry test names and failures).
pub fn check_result_url(url: &str) -> Result<url::Url, String> {
    let u = url::Url::parse(url.trim()).map_err(|_| "That isn't a web address.".to_string())?;
    match u.scheme() {
        "https" if u.host_str().is_some_and(|h| !h.is_empty()) => Ok(u),
        _ => Err("Result addresses must start with https://".into()),
    }
}

/// POSTs a suite result message (JSON) and returns the HTTP status. One try; the caller retries.
pub async fn post_result(url: &str, body: &Value) -> Result<u16, String> {
    let url = check_result_url(url)?;
    send_json(url, body, RESULT_TIMEOUT).await
}

/// What a service answered a result message: the status and the start of its reply, so "Send a
/// test message" can show Slack's `invalid_payload` or Teams' error in its own words.
#[derive(serde::Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PostReply {
    pub status: u16,
    pub body: String,
}

/// The most of a reply kept: enough for an error message, never a whole page.
pub const REPLY_MAX: usize = 300;

/// POSTs a result message (plain JSON, Slack Block Kit or a Teams Adaptive Card) and returns the
/// status with the start of the reply. One try; the caller retries.
pub async fn post_message(url: &str, body: &Value) -> Result<PostReply, String> {
    let url = check_result_url(url)?;
    send_json_reply(url, body, RESULT_TIMEOUT).await
}

async fn send_json_reply(url: url::Url, body: &Value, timeout: Duration) -> Result<PostReply, String> {
    let res = client(timeout)?.post(url).json(body).send().await.map_err(|e| send_error(e, timeout))?;
    let status = res.status().as_u16();
    // A slow or huge reply doesn't hold the answer up: the status is what counts.
    let text = tokio::time::timeout(Duration::from_secs(5), res.text()).await.ok().and_then(Result::ok).unwrap_or_default();
    Ok(PostReply { status, body: reply_excerpt(&text) })
}

/// The reply as one short line: whitespace collapsed, cut at REPLY_MAX characters.
pub fn reply_excerpt(text: &str) -> String {
    let one: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one.chars().count() <= REPLY_MAX {
        one
    } else {
        format!("{}…", one.chars().take(REPLY_MAX).collect::<String>())
    }
}

fn send_error(e: reqwest::Error, timeout: Duration) -> String {
    if e.is_timeout() {
        format!("The address didn't answer within {} seconds", timeout.as_secs())
    } else {
        "Couldn't reach the address".to_string()
    }
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(RESULT_CONNECT_TIMEOUT.min(timeout))
        // A redirect could lead to a plain http or local address; the status is reported instead.
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("Breakpatch/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// The biggest screenshot handed to the UI (a full-page PNG is well under this).
pub const SHOT_MAX_BYTES: u64 = 15 * 1024 * 1024;

/// Reads a failure screenshot for a result message or an issue: only a `.png` or `.jpg` file
/// inside the engine's screenshots folder (the same folder the asset protocol allows), after
/// following links, so nothing else on the Mac can be read this way.
pub fn read_screenshot(base: &std::path::Path, path: &str) -> Result<Vec<u8>, String> {
    let refused = || "That isn't one of Breakpatch's screenshots.".to_string();
    let base = base.canonicalize().map_err(|_| refused())?;
    let file = std::path::Path::new(path).canonicalize().map_err(|_| "The screenshot isn't on this Mac any more.".to_string())?;
    if !file.starts_with(&base) {
        return Err(refused());
    }
    let ext = file.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(ext.as_deref(), Some("png" | "jpg" | "jpeg")) {
        return Err(refused());
    }
    let meta = std::fs::metadata(&file).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > SHOT_MAX_BYTES {
        return Err(refused());
    }
    std::fs::read(&file).map_err(|e| e.to_string())
}

/// The POST itself, after the address was checked (tests call it with a local http server).
async fn send_json(url: url::Url, body: &Value, timeout: Duration) -> Result<u16, String> {
    let res = client(timeout)?.post(url).json(body).send().await.map_err(|e| send_error(e, timeout))?;
    Ok(res.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meminfo_parses() {
        assert_eq!(parse_meminfo("MemFree: 1 kB\nMemTotal:       16777216 kB\n"), Some(16 << 30));
        assert_eq!(parse_meminfo("nothing"), None);
    }

    #[test]
    fn memory_is_reported_here() {
        #[cfg(any(target_os = "macos", target_os = "linux"))]
        assert!(memory_gb() > 0);
    }

    #[test]
    fn result_urls_are_checked() {
        assert!(check_result_url("https://hooks.example.com/breakpatch/smoke").is_ok());
        assert!(check_result_url("  https://hooks.example.com/x  ").is_ok());
        for bad in [
            "http://hooks.example.com/x",
            "file:///etc/passwd",
            "ftp://example.com",
            "javascript:alert(1)",
            "https://",
            "not a url",
            "",
        ] {
            assert!(check_result_url(bad).is_err(), "{bad} should be refused");
        }
        assert_eq!(check_result_url("http://example.com").unwrap_err(), "Result addresses must start with https://");
    }

    #[tokio::test]
    async fn plain_http_is_refused_before_sending() {
        let err = post_result("http://127.0.0.1:9/x", &serde_json::json!({})).await.unwrap_err();
        assert_eq!(err, "Result addresses must start with https://");
    }

    /// A one-shot local server: answers `reply` (or never, when None) and hands back the request.
    async fn serve_once(reply: Option<&'static str>) -> (url::Url, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = url::Url::parse(&format!("http://{}/hook", listener.local_addr().unwrap())).unwrap();
        let task = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let n = sock.read(&mut chunk).await.unwrap();
                buf.extend_from_slice(&chunk[..n]);
                let text = String::from_utf8_lossy(&buf).to_string();
                if let Some(head_end) = text.find("\r\n\r\n") {
                    let len = text[..head_end]
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if buf.len() >= head_end + 4 + len || n == 0 {
                        break;
                    }
                }
                if n == 0 {
                    break;
                }
            }
            let request = String::from_utf8_lossy(&buf).to_string();
            match reply {
                Some(r) => {
                    sock.write_all(r.as_bytes()).await.unwrap();
                    let _ = sock.shutdown().await;
                }
                None => tokio::time::sleep(Duration::from_secs(30)).await,
            }
            request
        });
        (url, task)
    }

    #[tokio::test]
    async fn posts_the_message_as_json_and_returns_the_status() {
        let (url, server) =
            serve_once(Some("HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")).await;
        let body = serde_json::json!({ "suite": "Smoke", "result": "passed" });
        assert_eq!(send_json(url, &body, RESULT_TIMEOUT).await.unwrap(), 202);
        let request = server.await.unwrap();
        assert!(request.starts_with("POST /hook "), "{request}");
        assert!(request.to_ascii_lowercase().contains("content-type: application/json"), "{request}");
        assert!(request.ends_with(r#"{"result":"passed","suite":"Smoke"}"#), "{request}");
    }

    #[tokio::test]
    async fn an_error_status_is_returned_not_hidden() {
        let (url, _server) =
            serve_once(Some("HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"))
                .await;
        assert_eq!(send_json(url, &serde_json::json!({}), RESULT_TIMEOUT).await.unwrap(), 500);
    }

    #[tokio::test]
    async fn redirects_are_not_followed() {
        let (url, _server) =
            serve_once(Some("HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:9/elsewhere\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")).await;
        assert_eq!(send_json(url, &serde_json::json!({}), RESULT_TIMEOUT).await.unwrap(), 302);
    }

    #[tokio::test]
    async fn a_silent_address_times_out() {
        let (url, _server) = serve_once(None).await;
        let started = std::time::Instant::now();
        let err = send_json(url, &serde_json::json!({}), Duration::from_millis(300)).await.unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(5));
        assert!(err.contains("didn't answer"), "{err}");
    }

    #[tokio::test]
    async fn the_reply_comes_back_with_the_status() {
        let (url, server) = serve_once(Some(
            "HTTP/1.1 400 Bad Request\r\ncontent-type: text/plain\r\ncontent-length: 15\r\nconnection: close\r\n\r\ninvalid_payload",
        ))
        .await;
        let body = serde_json::json!({ "text": "Smoke failed", "blocks": [] });
        let reply = send_json_reply(url, &body, RESULT_TIMEOUT).await.unwrap();
        assert_eq!(reply, PostReply { status: 400, body: "invalid_payload".into() });
        let request = server.await.unwrap();
        assert!(request.ends_with(r#"{"blocks":[],"text":"Smoke failed"}"#), "{request}");
    }

    #[tokio::test]
    async fn an_accepted_message_with_no_reply_is_fine() {
        let (url, _server) =
            serve_once(Some("HTTP/1.1 202 Accepted\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")).await;
        let reply = send_json_reply(url, &serde_json::json!({}), RESULT_TIMEOUT).await.unwrap();
        assert_eq!(reply, PostReply { status: 202, body: String::new() });
    }

    #[tokio::test]
    async fn messages_refuse_what_results_refuse() {
        for bad in ["http://127.0.0.1:9/x", "file:///etc/passwd", "javascript:alert(1)"] {
            assert!(post_message(bad, &serde_json::json!({})).await.is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn a_silent_service_times_out_for_messages_too() {
        let (url, _server) = serve_once(None).await;
        let err = send_json_reply(url, &serde_json::json!({}), Duration::from_millis(300)).await.unwrap_err();
        assert!(err.contains("didn't answer"), "{err}");
    }

    #[test]
    fn replies_are_cut_short_and_on_one_line() {
        assert_eq!(reply_excerpt("  no_service\n "), "no_service");
        let long = "x".repeat(REPLY_MAX + 50);
        let cut = reply_excerpt(&long);
        assert_eq!(cut.chars().count(), REPLY_MAX + 1);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn only_screenshots_in_the_folder_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let shots = dir.path().join("screenshots");
        std::fs::create_dir_all(shots.join("run-1")).unwrap();
        let png = shots.join("run-1").join("step-5.png");
        std::fs::write(&png, b"\x89PNG....").unwrap();
        assert_eq!(read_screenshot(&shots, png.to_str().unwrap()).unwrap(), b"\x89PNG....");

        let outside = dir.path().join("secret.png");
        std::fs::write(&outside, b"nope").unwrap();
        assert!(read_screenshot(&shots, outside.to_str().unwrap()).is_err());
        let sneaky = shots.join("run-1").join("..").join("..").join("secret.png");
        assert!(read_screenshot(&shots, sneaky.to_str().unwrap()).is_err());
        let text = shots.join("run-1").join("notes.txt");
        std::fs::write(&text, b"hi").unwrap();
        assert!(read_screenshot(&shots, text.to_str().unwrap()).is_err());
        assert!(read_screenshot(&shots, shots.join("gone.png").to_str().unwrap()).is_err());
        #[cfg(unix)]
        {
            let link = shots.join("run-1").join("link.png");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(read_screenshot(&shots, link.to_str().unwrap()).is_err(), "a link out of the folder is refused");
        }
    }

    #[test]
    fn one_try_is_bounded() {
        assert_eq!(RESULT_TIMEOUT, Duration::from_secs(20));
        assert!(RESULT_CONNECT_TIMEOUT <= RESULT_TIMEOUT);
    }

    #[test]
    fn keep_awake_off_is_safe() {
        let k = KeepAwake::default();
        k.set(false).unwrap();
        assert!(!k.is_on());
    }
}

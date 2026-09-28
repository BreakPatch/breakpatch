//! Opened `.bpworkspace` files (file association). The text is emitted as `workspace-file`.
//! At a cold launch the file arrives before the UI listens, so it is also kept until the UI
//! asks for it once with `workspace_file_take`; after that, events alone are enough.

use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Runtime};

pub const EVENT_NAME: &str = "workspace-file";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Default)]
pub struct WorkspaceInbox {
    pending: Mutex<Option<String>>,
    ui_listening: AtomicBool,
}

impl WorkspaceInbox {
    pub fn offer<R: Runtime>(&self, app: &AppHandle<R>, text: String) {
        if !self.ui_listening.load(Ordering::SeqCst) {
            *self.pending.lock().unwrap() = Some(text.clone());
        }
        if let Err(e) = app.emit(EVENT_NAME, text) {
            log::warn!("couldn't emit {EVENT_NAME}: {e}");
        }
    }

    /// Called by the UI once its listener is up: hands over a file opened at launch.
    pub fn take(&self) -> Option<String> {
        self.ui_listening.store(true, Ordering::SeqCst);
        self.pending.lock().unwrap().take()
    }
}

pub fn is_workspace_path(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("bpworkspace"))
}

pub fn read_workspace_file(path: &Path) -> Result<String, String> {
    if !is_workspace_path(path) {
        return Err(format!("{} isn't a .bpworkspace file", path.display()));
    }
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_BYTES {
        return Err(format!("{} is too large to be a workspace file", path.display()));
    }
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

/// Reads and offers every workspace file in `paths`; other paths are ignored.
pub fn open_paths<R: Runtime, P: AsRef<Path>>(
    app: &AppHandle<R>,
    inbox: &WorkspaceInbox,
    paths: impl IntoIterator<Item = P>,
) {
    for p in paths {
        let p = p.as_ref();
        if !is_workspace_path(p) {
            continue;
        }
        match read_workspace_file(p) {
            Ok(text) => inbox.offer(app, text),
            Err(e) => log::warn!("couldn't open workspace file: {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_and_reads_workspace_files() {
        let dir = tempfile::tempdir().unwrap();
        let good = dir.path().join("team.BPWorkspace");
        std::fs::write(&good, r#"{"name":"Acme"}"#).unwrap();
        assert_eq!(read_workspace_file(&good).unwrap(), r#"{"name":"Acme"}"#);
        let other = dir.path().join("notes.json");
        std::fs::write(&other, "{}").unwrap();
        assert!(read_workspace_file(&other).is_err());
        assert!(!is_workspace_path(Path::new("breakpatch://connect")));
    }

    #[test]
    fn inbox_keeps_until_taken() {
        let inbox = WorkspaceInbox::default();
        *inbox.pending.lock().unwrap() = Some("a".into());
        assert_eq!(inbox.take().as_deref(), Some("a"));
        assert_eq!(inbox.take(), None);
    }
}

//! Opened `.bpworkspace` files (file association). The text is emitted as `workspace-file`.
//! At a cold launch the file arrives before the UI listens, so it is also kept until the UI
//! asks for it once with `workspace_file_take`; after that, events alone are enough.
//!
//! macOS hands opened files to the running app (`RunEvent::Opened`). Linux and Windows start the
//! app with the file as an argument: at launch (`launch_paths`), or in a second process that hands
//! its arguments to the first and quits (tauri-plugin-single-instance, lib.rs).

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
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

/// The `.bpworkspace` files among a launch's arguments (without the program's own name): plain
/// paths, relative ones taken from `cwd` (the folder the launch was made in, which for a second
/// launch isn't this process's), or `file://` URLs, which file managers pass for a desktop entry's
/// `%u`. Anything else (a `breakpatch://` link, an option) isn't a workspace file and is left out.
pub fn launch_paths<I, S>(args: I, cwd: &Path) -> Vec<PathBuf>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    args.into_iter()
        .filter_map(|a| {
            let a = a.as_ref();
            let path = match a.to_str() {
                // Only "file:" is a URL here: C:\x.bpworkspace parses as one too (scheme "c").
                Some(s) if s.get(..5).is_some_and(|p| p.eq_ignore_ascii_case("file:")) => {
                    url::Url::parse(s).ok()?.to_file_path().ok()?
                }
                _ => PathBuf::from(a),
            };
            is_workspace_path(&path).then(|| if path.is_absolute() { path } else { cwd.join(path) })
        })
        .collect()
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
            Err(e) => log::warn!("couldn't open workspace file {}: {e}", p.display()),
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
    fn launch_arguments_give_workspace_files_only() {
        let cwd = Path::new("/home/ana/Downloads");
        let args = [
            "/home/ana/team.bpworkspace",
            "relative/acme.BPWORKSPACE",
            "file:///home/ana/My%20Files/club.bpworkspace",
            "FILE:///tmp/upper.bpworkspace",
            "breakpatch://connect#c=abc",
            "--minimized",
            "notes.json",
            "file:///home/ana/notes.json",
            "file://not a url.bpworkspace",
            "été.json",
        ];
        assert_eq!(
            launch_paths(args, cwd),
            [
                PathBuf::from("/home/ana/team.bpworkspace"),
                PathBuf::from("/home/ana/Downloads/relative/acme.BPWORKSPACE"),
                PathBuf::from("/home/ana/My Files/club.bpworkspace"),
                PathBuf::from("/tmp/upper.bpworkspace"),
            ]
        );
        assert!(launch_paths(Vec::<String>::new(), cwd).is_empty());
    }

    /// What a second launch hands over reaches the UI like a file opened at launch: kept until
    /// the UI asks, and once it listens, emitted only.
    #[test]
    fn a_file_from_a_second_launch_is_read_and_offered() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("team.bpworkspace"), r#"{"name":"Acme"}"#).unwrap();
        let paths = launch_paths(["team.bpworkspace", "breakpatch://connect#c=x"], dir.path());
        assert_eq!(paths, [dir.path().join("team.bpworkspace")]);
        assert_eq!(read_workspace_file(&paths[0]).unwrap(), r#"{"name":"Acme"}"#);
    }

    #[test]
    fn inbox_keeps_until_taken() {
        let inbox = WorkspaceInbox::default();
        *inbox.pending.lock().unwrap() = Some("a".into());
        assert_eq!(inbox.take().as_deref(), Some("a"));
        assert_eq!(inbox.take(), None);
    }
}

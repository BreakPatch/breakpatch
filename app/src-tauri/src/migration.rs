//! Upgrade to Team, the last step (the Team module's `upgrade/`, and the plan in the Team repo's
//! docs/migration-and-workspaces.md): once a tests folder has been copied into a workspace and
//! read back, the local copy goes to the Trash. On a Mac that's NSFileManager's Trash, which needs
//! no Automation permission (Finder over Apple Events would, and a notarized build can't ask for
//! it without an entitlement). Finder may not offer Put Back for what it moves, so the app says
//! to drag the items back out of the Trash to undo it.
//!
//! [`trash_items`] only accepts an allow-list, checked before anything moves:
//! - in a tests folder the person opened in Breakpatch ([`trash_from_folder`]: the fs scope, which
//!   holds only folders picked in a dialog) that has a valid `breakpatch.json`: the names
//!   `breakpatch.json`, `apps` and `suites`, directly under it. Nothing else in the folder
//!   (`files/`, `.git`, a README) can be named, and `breakpatch.json` always goes last, so an
//!   interrupted move can be checked again. Once `breakpatch.json` has gone, or the folder has,
//!   every name only comes back as missing: that's how an interrupted move finishes, and nothing
//!   more can move out of a folder without one.
//! - in the engine's screenshots folder (`<data>/Breakpatch/screenshots`, the one the asset scope
//!   allows): run folders by name, directly under it.
//!
//! A name is one plain path component (no `/`, `..` or leading dot), and a link is never followed
//! or moved. The folder itself may be reached through a link: it's resolved first, and what's
//! checked is what moves. Keychain entries are never touched here.
//!
//! Time of check and time of use: each item is checked just before the moves start (and the UI
//! compared every file's hash just before that), but the checks and the moves aren't one atomic
//! step. A `git pull` in between isn't seen. That window is accepted: whatever moves is in the
//! Trash, and the copy in the workspace was read back first.
//!
//! [`git_repo_of`] only looks for a `.git` next to the folder or above it; it never runs git.

use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// What may be moved out of a tests folder, in the order they move (`breakpatch.json` last).
pub const FOLDER_ITEMS: [&str; 3] = ["apps", "suites", "breakpatch.json"];
/// Longest report kept (the report is a list of names and counts; this is plenty).
pub const MAX_REPORT_BYTES: usize = 1024 * 1024;

const NOT_TESTS_FOLDER: &str = "This isn't a Breakpatch tests folder (its breakpatch.json is missing or not valid).";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// A tests folder with a valid `breakpatch.json`.
    Folder,
    /// The engine's screenshots folder.
    Screenshots,
}

impl Place {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "folder" => Some(Self::Folder),
            "screenshots" => Some(Self::Screenshots),
            _ => None,
        }
    }
}

#[derive(Serialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TrashResult {
    /// Moved to the Trash now.
    pub moved: Vec<String>,
    /// Not there (already moved, or never made): nothing to do.
    pub missing: Vec<String>,
    /// Why moving stopped part-way, in plain words. What's in `moved` went before it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// One plain path component: not empty, no separators, no `..`, no leading dot, not too long.
fn plain_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 128 && !name.starts_with('.') && !name.contains(['/', '\\', '\0', ':'])
}

/// A run folder name as the engine makes it (runner.py `safe_name`): letters, digits, `_` and `-`.
fn run_folder_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Whether `dir` holds a `breakpatch.json` that is a Breakpatch folder file (a plain file, not a link).
pub fn is_tests_folder(dir: &Path) -> bool {
    let file = dir.join("breakpatch.json");
    let Ok(meta) = std::fs::symlink_metadata(&file) else { return false };
    if !meta.is_file() || meta.len() > 64 * 1024 {
        return false;
    }
    std::fs::read_to_string(&file)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get("format").and_then(|f| f.as_str()) == Some("breakpatch"))
}

/// The names asked for, allowed and in the order they move. Refuses the whole request if any
/// isn't allowed.
fn allowed_names(place: Place, names: &[String]) -> Result<Vec<&str>, String> {
    let mut ordered: Vec<&str> = Vec::new();
    match place {
        Place::Folder => {
            for n in names {
                if !FOLDER_ITEMS.contains(&n.as_str()) {
                    return Err(format!(
                        "Breakpatch only moves breakpatch.json, apps and suites from a tests folder, not {n}."
                    ));
                }
            }
            ordered.extend(FOLDER_ITEMS.iter().copied().filter(|i| names.iter().any(|n| n == i)));
        }
        Place::Screenshots => {
            for n in names {
                if !run_folder_name(n) {
                    return Err(format!("{n} isn't a run's screenshots folder."));
                }
                if !ordered.contains(&n.as_str()) {
                    ordered.push(n);
                }
            }
        }
    }
    Ok(ordered)
}

/// The paths to move for this request, in order, and the names that aren't there. Refuses the
/// whole request if any name isn't allowed, so nothing moves on a bad request. A folder that
/// isn't there any more, or a tests folder whose `breakpatch.json` went already, has every name
/// missing (and refuses a request naming anything still in it).
pub fn plan(place: Place, base: &Path, names: &[String]) -> Result<(Vec<PathBuf>, Vec<String>), String> {
    if !base.is_absolute() {
        return Err("The folder must be a full path.".into());
    }
    let ordered = allowed_names(place, names)?;
    if ordered.is_empty() {
        return Ok((Vec::new(), Vec::new()));
    }
    let all_missing = || ordered.iter().map(|n| n.to_string()).collect::<Vec<_>>();
    match std::fs::symlink_metadata(base) {
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok((Vec::new(), all_missing())),
        Err(_) => return Err(format!("Breakpatch can't look in this folder ({} refused it).", Os::current().name())),
        Ok(m) if !m.is_dir() => return Err("This isn't a folder.".into()),
        Ok(_) => {}
    }
    if place == Place::Folder {
        if std::fs::symlink_metadata(base.join("breakpatch.json")).is_err() {
            // breakpatch.json goes last, so a folder without it may only be finishing: nothing
            // asked for may still be there.
            if ordered.iter().any(|n| std::fs::symlink_metadata(base.join(n)).is_ok()) {
                return Err(NOT_TESTS_FOLDER.into());
            }
            return Ok((Vec::new(), all_missing()));
        }
        if !is_tests_folder(base) {
            return Err(NOT_TESTS_FOLDER.into());
        }
    }
    let mut paths = Vec::new();
    let mut missing = Vec::new();
    for name in ordered {
        debug_assert!(plain_name(name));
        let p = base.join(name);
        match std::fs::symlink_metadata(&p) {
            Err(_) => missing.push(name.to_string()),
            Ok(m) if m.file_type().is_symlink() => {
                return Err(format!("{name} is a link, so Breakpatch leaves it where it is."));
            }
            Ok(m) => {
                let want_file = place == Place::Folder && name == "breakpatch.json";
                if want_file != m.is_file() || (!want_file && !m.is_dir()) {
                    return Err(format!("{name} isn't what Breakpatch expects here, so it's left where it is."));
                }
                paths.push(p);
            }
        }
    }
    Ok((paths, missing))
}

/// Moves the allowed items with `mover` (the Trash in the app). Stops at the first failure and
/// says why in `error`; what moved before it stays moved and is listed, and asking again moves
/// the rest.
pub fn trash_items(
    place: Place,
    base: &Path,
    names: &[String],
    mover: impl Fn(&Path) -> Result<(), String>,
) -> Result<TrashResult, String> {
    let (paths, missing) = plan(place, base, names)?;
    let mut out = TrashResult { moved: Vec::new(), missing, error: None };
    for p in paths {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if let Err(e) = mover(&p) {
            out.error = Some(format!("Couldn't move {name} to {}. {e}", Os::current().trash()));
            break;
        }
        out.moved.push(name);
    }
    Ok(out)
}

/// The tests folder a request names, as the real folder: a full path that `allowed` (the fs
/// scope in the app) lets Breakpatch use, followed through any link, so what's checked is what
/// moves. A folder that isn't there any more comes back as named: [`plan`] finds nothing in it.
pub fn resolve_folder(given: &Path, allowed: impl Fn(&Path) -> bool) -> Result<PathBuf, String> {
    if !given.is_absolute() {
        return Err("The folder must be a full path.".into());
    }
    let real = match std::fs::canonicalize(given) {
        Ok(p) => p,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(given.to_path_buf()),
        Err(_) => return Err(format!("Breakpatch can't look in this folder ({} refused it).", Os::current().name())),
    };
    if !allowed(&real) {
        return Err("Breakpatch only moves a tests folder you opened in it.".into());
    }
    Ok(real)
}

/// [`trash_items`] in a tests folder, once [`resolve_folder`] has checked it.
pub fn trash_from_folder(
    given: &Path,
    names: &[String],
    allowed: impl Fn(&Path) -> bool,
    mover: impl Fn(&Path) -> Result<(), String>,
) -> Result<TrashResult, String> {
    let base = resolve_folder(given, allowed)?;
    trash_items(Place::Folder, &base, names, mover)
}

/// The operating system's Trash. On a Mac, NSFileManager's (see the module docs); elsewhere the
/// trash crate's default.
pub fn to_trash(p: &Path) -> Result<(), String> {
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))]
    let mut ctx = trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(p).map_err(|e| trash_error_text(&e.to_string()))
}

/// The operating system, for the words the person reads: the Recycle Bin on Windows, and what
/// to check when it refuses.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    pub const fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::Mac
        } else if cfg!(windows) {
            Os::Windows
        } else {
            Os::Linux
        }
    }

    /// "macOS refused it".
    pub const fn name(self) -> &'static str {
        match self {
            Os::Mac => "macOS",
            Os::Windows => "Windows",
            Os::Linux => "the system",
        }
    }

    /// "move it to the Trash".
    pub const fn trash(self) -> &'static str {
        match self {
            Os::Windows => "the Recycle Bin",
            Os::Mac | Os::Linux => "the Trash",
        }
    }
}

/// What to tell the person when the Trash refused an item: a permission problem says what to
/// check, anything else passes on what the system said.
pub fn trash_error_text(raw: &str) -> String {
    trash_error_text_for(Os::current(), raw)
}

pub fn trash_error_text_for(os: Os, raw: &str) -> String {
    let low = raw.to_lowercase();
    let refused = ["permission", "not permitted", "code=513", "code=257", "-1743", "access"].iter().any(|k| low.contains(k));
    let read_only = low.contains("readonlyfilesystem") || low.contains("read-only");
    let no_trash = match os {
        Os::Mac => low.contains("code=3328") || low.contains("unsupported"),
        // The trash crate found neither the home Trash nor one on the folder's disk.
        Os::Linux => low.contains("valid 'home trash'") || low.contains("unsupported"),
        Os::Windows => low.contains("unsupported"),
    };
    match os {
        Os::Mac if refused => "macOS didn't let Breakpatch move it. Check that you can change this folder in Finder (File, Get Info, Sharing & Permissions), and that Breakpatch is allowed in System Settings, Privacy & Security, Files and Folders.".into(),
        Os::Windows if refused => "Windows didn't let Breakpatch move it. Check that you can change this folder in File Explorer (Properties, Security), and that no other program has a file in it open.".into(),
        Os::Linux if refused || read_only => "Breakpatch isn't allowed to move it. Check that you can change this folder (its permissions, in your file manager's Properties) and that its disk isn't read-only.".into(),
        _ if no_trash => format!("This disk has no {} (a network disk, for example), so Breakpatch leaves the folder as it is.", os.trash().trim_start_matches("the ")),
        _ => format!("The system said: {raw}"),
    }
}

/// The Git repository holding `path`: the nearest folder at or above it with a `.git` (a folder,
/// or a file for a worktree or submodule). Only looks; git is never run.
pub fn git_repo_of(path: &Path) -> Option<PathBuf> {
    path.ancestors().find(|a| std::fs::symlink_metadata(a.join(".git")).is_ok()).map(Path::to_path_buf)
}

/// Writes an upgrade report into `<app data>/reports/` and returns its path.
pub fn save_report(dir: &Path, now: i64, text: &str) -> Result<PathBuf, String> {
    if text.len() > MAX_REPORT_BYTES {
        return Err("The report is too long to keep.".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut path = dir.join(format!("upgrade-to-team-{now}.txt"));
    let mut n = 1;
    while path.exists() {
        n += 1;
        path = dir.join(format!("upgrade-to-team-{now}-{n}.txt"));
    }
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::fs;

    fn names(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// A tests folder like Community makes, with things around it that must never move.
    fn folder() -> tempfile::TempDir {
        let d = tempfile::tempdir().unwrap();
        let p = d.path();
        fs::write(p.join("breakpatch.json"), r#"{"format":"breakpatch","schemaVersion":1,"name":"tests"}"#).unwrap();
        fs::create_dir_all(p.join("apps/web/tests")).unwrap();
        fs::write(p.join("apps/web/app.json"), "{}").unwrap();
        fs::create_dir_all(p.join("suites")).unwrap();
        fs::create_dir_all(p.join("files")).unwrap();
        fs::write(p.join("files/cv.pdf"), "x").unwrap();
        fs::create_dir_all(p.join(".git")).unwrap();
        fs::write(p.join("README.md"), "hi").unwrap();
        d
    }

    /// Records what would move and removes it (never the real Trash).
    fn fake_trash(moved: &RefCell<Vec<PathBuf>>) -> impl Fn(&Path) -> Result<(), String> + '_ {
        move |p: &Path| {
            if p.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) }.map_err(|e| e.to_string())?;
            moved.borrow_mut().push(p.to_path_buf());
            Ok(())
        }
    }

    #[test]
    fn moves_only_the_listed_items_and_breakpatch_json_last() {
        let d = folder();
        let base = d.path();
        let moved = RefCell::new(Vec::new());
        let r = trash_items(Place::Folder, base, &names(&["breakpatch.json", "suites", "apps"]), fake_trash(&moved))
            .unwrap();
        assert_eq!(r.moved, names(&["apps", "suites", "breakpatch.json"]));
        assert!(r.missing.is_empty());
        // Everything else is where it was.
        assert!(base.join("files/cv.pdf").exists());
        assert!(base.join(".git").is_dir());
        assert!(base.join("README.md").exists());
        assert!(!base.join("apps").exists() && !base.join("suites").exists() && !base.join("breakpatch.json").exists());
    }

    #[test]
    fn refuses_anything_outside_the_allow_list_before_moving_anything() {
        let d = folder();
        let moved = RefCell::new(Vec::new());
        for bad in [
            &["apps", "files"][..],
            &["apps", ".git"],
            &["README.md"],
            &["apps/web"],
            &["../x"],
            &[".."],
            &["apps", "/etc"],
        ] {
            let err = trash_items(Place::Folder, d.path(), &names(bad), fake_trash(&moved)).unwrap_err();
            assert!(err.starts_with("Breakpatch only moves"), "{bad:?}: {err}");
        }
        assert!(moved.borrow().is_empty());
        assert!(d.path().join("apps").is_dir());
    }

    #[test]
    fn refuses_a_folder_without_a_valid_breakpatch_json() {
        let d = folder();
        let moved = RefCell::new(Vec::new());
        fs::write(d.path().join("breakpatch.json"), r#"{"format":"something-else"}"#).unwrap();
        assert!(trash_items(Place::Folder, d.path(), &names(&["apps"]), fake_trash(&moved))
            .unwrap_err()
            .contains("isn't a Breakpatch tests folder"));
        fs::write(d.path().join("breakpatch.json"), "not json").unwrap();
        assert!(trash_items(Place::Folder, d.path(), &names(&["apps"]), fake_trash(&moved)).is_err());
        fs::remove_file(d.path().join("breakpatch.json")).unwrap();
        assert!(trash_items(Place::Folder, d.path(), &names(&["apps", "suites"]), fake_trash(&moved)).is_err());
        assert!(trash_items(Place::Folder, Path::new("relative/tests"), &names(&["apps"]), fake_trash(&moved)).is_err());
        assert!(moved.borrow().is_empty());
    }

    #[test]
    fn an_interrupted_move_can_finish_and_missing_items_are_reported() {
        let d = folder();
        let moved = RefCell::new(Vec::new());
        fs::remove_dir_all(d.path().join("apps")).unwrap();
        let r = trash_items(Place::Folder, d.path(), &names(&["apps", "suites"]), fake_trash(&moved)).unwrap();
        assert_eq!((r.moved, r.missing), (names(&["suites"]), names(&["apps"])));
        // Only breakpatch.json left, then gone: asking again is fine.
        let r = trash_items(Place::Folder, d.path(), &names(&["breakpatch.json"]), fake_trash(&moved)).unwrap();
        assert_eq!(r.moved, names(&["breakpatch.json"]));
        let r = trash_items(Place::Folder, d.path(), &names(&["breakpatch.json"]), fake_trash(&moved)).unwrap();
        assert_eq!(r.missing, names(&["breakpatch.json"]));
    }

    #[test]
    fn a_move_whose_folder_items_all_went_finishes_with_everything_missing() {
        // The shell moved all three, then the app stopped before the journal heard of it.
        let d = folder();
        let moved = RefCell::new(Vec::new());
        trash_items(Place::Folder, d.path(), &names(&["apps", "suites", "breakpatch.json"]), fake_trash(&moved))
            .unwrap();
        let r =
            trash_items(Place::Folder, d.path(), &names(&["apps", "suites", "breakpatch.json"]), fake_trash(&moved))
                .unwrap();
        assert_eq!((r.moved, r.missing, r.error), (vec![], names(&["apps", "suites", "breakpatch.json"]), None));
        // Without breakpatch.json, nothing still in the folder may be named.
        fs::create_dir_all(d.path().join("apps")).unwrap();
        let err = trash_items(Place::Folder, d.path(), &names(&["apps"]), fake_trash(&moved)).unwrap_err();
        assert!(err.contains("isn't a Breakpatch tests folder"), "{err}");
        assert!(d.path().join("apps").is_dir() && d.path().join("files/cv.pdf").exists());
    }

    #[test]
    fn a_folder_or_screenshots_folder_that_is_gone_has_everything_missing() {
        let d = tempfile::tempdir().unwrap();
        let moved = RefCell::new(Vec::new());
        let gone = d.path().join("moved-away");
        let r = trash_items(Place::Folder, &gone, &names(&["apps", "breakpatch.json"]), fake_trash(&moved)).unwrap();
        assert_eq!(r.missing, names(&["apps", "breakpatch.json"]));
        let r = trash_items(Place::Screenshots, &gone, &names(&["log-in-1"]), fake_trash(&moved)).unwrap();
        assert_eq!(r.missing, names(&["log-in-1"]));
        // Names are still checked first.
        assert!(trash_items(Place::Folder, &gone, &names(&["files"]), fake_trash(&moved)).is_err());
        assert!(moved.borrow().is_empty());
    }

    #[test]
    fn a_failure_part_way_says_what_moved_before_it() {
        let d = folder();
        let failing = |p: &Path| {
            if p.ends_with("suites") {
                return Err("locked".to_string());
            }
            fs::remove_dir_all(p).map_err(|e| e.to_string())
        };
        let r = trash_items(Place::Folder, d.path(), &names(&["apps", "suites", "breakpatch.json"]), failing).unwrap();
        assert_eq!(r.moved, names(&["apps"]));
        let said = format!("Couldn't move suites to {}. locked", Os::current().trash());
        assert_eq!(r.error.as_deref(), Some(said.as_str()));
        #[cfg(not(windows))]
        assert_eq!(said, "Couldn't move suites to the Trash. locked");
        assert!(d.path().join("breakpatch.json").exists(), "breakpatch.json stays when an item before it fails");
        let json = serde_json::to_value(&r).unwrap();
        assert_eq!(json["moved"], serde_json::json!(["apps"]));
        assert_eq!(json["error"], said);
        assert!(serde_json::to_value(TrashResult::default()).unwrap().get("error").is_none());
    }

    #[test]
    fn only_a_folder_opened_in_breakpatch_can_be_named() {
        let d = folder();
        let real = fs::canonicalize(d.path()).unwrap();
        let moved = RefCell::new(Vec::new());
        let picked = |p: &Path| p == real;
        let nothing = |_: &Path| false;
        // The command's checks: a full path, in the fs scope.
        assert!(trash_from_folder(Path::new("relative/tests"), &names(&["apps"]), picked, fake_trash(&moved))
            .unwrap_err()
            .contains("full path"));
        assert!(trash_from_folder(d.path(), &names(&["apps"]), nothing, fake_trash(&moved))
            .unwrap_err()
            .contains("opened in it"));
        assert!(moved.borrow().is_empty());
        let r = trash_from_folder(d.path(), &names(&["apps"]), picked, fake_trash(&moved)).unwrap();
        assert_eq!(r.moved, names(&["apps"]));
        // A folder moved away since: nothing to check against the scope, and nothing moves.
        let r = trash_from_folder(&d.path().join("gone"), &names(&["apps"]), nothing, fake_trash(&moved)).unwrap();
        assert_eq!(r.missing, names(&["apps"]));
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_reached_through_a_link_is_checked_and_moved_where_it_really_is() {
        let d = folder();
        let real = fs::canonicalize(d.path()).unwrap();
        let links = tempfile::tempdir().unwrap();
        let via = links.path().join("tests");
        std::os::unix::fs::symlink(d.path(), &via).unwrap();
        let moved = RefCell::new(Vec::new());
        // The scope is asked about the real folder, not the link.
        let seen = RefCell::new(Vec::new());
        let scope = |p: &Path| {
            seen.borrow_mut().push(p.to_path_buf());
            p == real
        };
        let r = trash_from_folder(&via, &names(&["apps"]), scope, fake_trash(&moved)).unwrap();
        assert_eq!(r.moved, names(&["apps"]));
        assert_eq!(*seen.borrow(), vec![real.clone()]);
        assert_eq!(moved.borrow().as_slice(), [real.join("apps")]);
        assert!(via.exists(), "the link itself stays");
    }

    #[test]
    fn a_refusal_by_macos_says_what_to_check() {
        let t = trash_error_text_for(Os::Mac, "While deleting '/x', `trashItemAtURL` failed: Error Domain=NSCocoaErrorDomain Code=513 \"You don't have permission\"");
        assert!(t.starts_with("macOS didn't let Breakpatch move it."), "{t}");
        assert!(trash_error_text_for(Os::Mac, "Code=3328 feature unsupported").contains("no Trash"));
        assert_eq!(trash_error_text_for(Os::Mac, "disk full"), "The system said: disk full");
    }

    /// The same refusals in each system's words, as the trash crate reports them there.
    #[test]
    fn refusals_on_windows_and_linux_say_what_to_check_there() {
        let win = trash_error_text_for(Os::Windows, "Error during a `trash` operation: Os { code: -2147024891, description: \"Access is denied.\" }");
        assert!(win.starts_with("Windows didn't let Breakpatch move it.") && win.contains("File Explorer"), "{win}");
        assert!(!win.contains("Finder") && !win.contains("macOS"));
        assert!(trash_error_text_for(Os::Windows, "unsupported").contains("no Recycle Bin"));

        let linux = trash_error_text_for(Os::Linux, "Error during a `trash` operation: FileSystem { path: \"/x\", source: Os { code: 13, kind: PermissionDenied, message: \"Permission denied\" } }");
        assert!(linux.starts_with("Breakpatch isn't allowed to move it."), "{linux}");
        assert!(!linux.contains("Finder") && !linux.contains("macOS"));
        assert!(trash_error_text_for(Os::Linux, "kind: ReadOnlyFilesystem").starts_with("Breakpatch isn't allowed"));
        let none = trash_error_text_for(Os::Linux, "Unknown { description: \"Could not find a valid 'home trash' nor valid trashes on other mount points\" }");
        assert!(none.contains("no Trash"), "{none}");
        assert_eq!(trash_error_text_for(Os::Linux, "disk full"), "The system said: disk full");

        assert_eq!(Os::Windows.trash(), "the Recycle Bin");
        assert_eq!(Os::Mac.trash(), "the Trash");
        assert_eq!(Os::Mac.name(), "macOS");
    }

    #[cfg(unix)]
    #[test]
    fn never_follows_or_moves_a_link() {
        let d = folder();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::remove_dir_all(d.path().join("suites")).unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), d.path().join("suites")).unwrap();
        let moved = RefCell::new(Vec::new());
        let err = trash_items(Place::Folder, d.path(), &names(&["apps", "suites"]), fake_trash(&moved)).unwrap_err();
        assert!(err.contains("is a link"));
        assert!(moved.borrow().is_empty() && elsewhere.path().exists());
    }

    #[test]
    fn a_file_where_a_folder_should_be_is_left_alone() {
        let d = folder();
        fs::remove_dir_all(d.path().join("suites")).unwrap();
        fs::write(d.path().join("suites"), "not a folder").unwrap();
        let moved = RefCell::new(Vec::new());
        assert!(trash_items(Place::Folder, d.path(), &names(&["suites"]), fake_trash(&moved)).is_err());
    }

    #[test]
    fn screenshots_are_run_folders_directly_under_the_screenshots_folder() {
        let d = tempfile::tempdir().unwrap();
        let shots = d.path().join("screenshots");
        fs::create_dir_all(shots.join("log-in-20260902-090000")).unwrap();
        fs::write(shots.join("log-in-20260902-090000/001-s1.png"), "png").unwrap();
        fs::create_dir_all(shots.join("other-run")).unwrap();
        let moved = RefCell::new(Vec::new());
        let r = trash_items(
            Place::Screenshots,
            &shots,
            &names(&["log-in-20260902-090000", "gone-run"]),
            fake_trash(&moved),
        )
        .unwrap();
        assert_eq!((r.moved, r.missing), (names(&["log-in-20260902-090000"]), names(&["gone-run"])));
        assert!(shots.join("other-run").exists());
        for bad in ["..", "a/b", ".hidden", "x y", ""] {
            assert!(trash_items(Place::Screenshots, &shots, &names(&[bad]), fake_trash(&moved)).is_err(), "{bad}");
        }
    }

    #[test]
    fn finds_the_git_repository_by_looking_only() {
        let d = tempfile::tempdir().unwrap();
        let tests = d.path().join("web/qa/tests");
        fs::create_dir_all(&tests).unwrap();
        assert_eq!(git_repo_of(&tests).filter(|p| p.starts_with(d.path())), None);
        fs::create_dir_all(d.path().join("web/.git")).unwrap();
        assert_eq!(git_repo_of(&tests), Some(d.path().join("web")));
        // A worktree's .git is a file.
        fs::write(d.path().join("web/qa/.git"), "gitdir: /elsewhere").unwrap();
        assert_eq!(git_repo_of(&tests), Some(d.path().join("web/qa")));
    }

    #[test]
    fn reports_are_kept_side_by_side() {
        let d = tempfile::tempdir().unwrap();
        let a = save_report(&d.path().join("reports"), 100, "one").unwrap();
        let b = save_report(&d.path().join("reports"), 100, "two").unwrap();
        assert_ne!(a, b);
        assert_eq!(fs::read_to_string(b).unwrap(), "two");
        assert!(save_report(d.path(), 1, &"x".repeat(MAX_REPORT_BYTES + 1)).is_err());
    }

    #[test]
    fn names_are_plain() {
        assert!(plain_name("apps") && plain_name("breakpatch.json"));
        assert!(!plain_name(".git") && !plain_name("a/b") && !plain_name("") && !plain_name("c:x"));
    }
}

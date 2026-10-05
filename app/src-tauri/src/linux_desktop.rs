//! An AppImage registers itself (Linux). A .deb registers `breakpatch://` links and `.bpworkspace`
//! files when it's installed: its desktop entry lists both (`MimeType=`), and it ships
//! `/usr/share/mime/packages/breakpatch.xml`. An AppImage installs nothing, so at each start it
//! does the same for this account: tauri-plugin-deep-link's `register_all` writes a hidden
//! `<binary>-handler.desktop` in `~/.local/share/applications` for the scheme, and this adds the
//! file type to it and puts the type's definition in `~/.local/share/mime`.
//!
//! Nothing here fails the start: a missing tool (`xdg-mime`, `update-mime-database`) is logged.

use std::ffi::OsStr;
use std::path::Path;

use tauri::{AppHandle, Manager, Runtime};

/// The `.bpworkspace` type, as `fileAssociations` in tauri.conf.json names it.
pub const WORKSPACE_MIME: &str = "application/x-breakpatch-workspace";
/// The type's definition: the same file the .deb installs (tauri.linux.conf.json).
pub const MIME_XML: &str = include_str!("../linux/breakpatch-mime.xml");
const MIME_FILE: &str = "breakpatch.xml";

/// Registers the scheme and the file type for this account. Runs commands, so off the main thread.
pub fn register_appimage<R: Runtime>(app: &AppHandle<R>) {
    use tauri_plugin_deep_link::DeepLinkExt;
    if let Err(e) = app.deep_link().register_all() {
        log::warn!("couldn't register the breakpatch:// scheme: {e}");
    }
    let (Ok(data), Some(handler)) = (app.path().data_dir(), handler_entry_name()) else {
        return;
    };
    if let Err(e) = register_workspace_files(&data, &handler, &mut run) {
        log::warn!("couldn't register .bpworkspace files: {e}");
    }
}

/// The deep-link plugin's name for its desktop entry: the running binary's name + `-handler.desktop`.
fn handler_entry_name() -> Option<String> {
    let exe = tauri::utils::platform::current_exe().ok()?;
    Some(format!("{}-handler.desktop", exe.file_name()?.to_string_lossy()))
}

fn run(cmd: &str, args: &[&OsStr]) {
    match std::process::Command::new(cmd).args(args).status() {
        Ok(s) if s.success() => {}
        Ok(s) => log::warn!("{cmd} failed ({s})"),
        Err(e) => log::warn!("couldn't run {cmd}: {e}"),
    }
}

/// Writes the type's definition under `data/mime` and adds the type to the handler entry in
/// `data/applications` (written by `register_all` just before). Makes the app the type's default
/// only when something changed, so a person's own choice stays from one start to the next.
pub fn register_workspace_files(
    data: &Path,
    handler: &str,
    run: &mut dyn FnMut(&str, &[&OsStr]),
) -> Result<(), String> {
    let mime_dir = data.join("mime");
    let xml = mime_dir.join("packages").join(MIME_FILE);
    let mut changed = false;
    if std::fs::read_to_string(&xml).ok().as_deref() != Some(MIME_XML) {
        std::fs::create_dir_all(xml.parent().unwrap_or(&mime_dir)).map_err(|e| e.to_string())?;
        std::fs::write(&xml, MIME_XML).map_err(|e| format!("{}: {e}", xml.display()))?;
        run("update-mime-database", &[mime_dir.as_os_str()]);
        changed = true;
    }
    let apps = data.join("applications");
    let entry_path = apps.join(handler);
    let entry = std::fs::read_to_string(&entry_path).map_err(|e| format!("{}: {e}", entry_path.display()))?;
    if let Some(updated) = with_mime_type(&entry, WORKSPACE_MIME) {
        std::fs::write(&entry_path, updated).map_err(|e| format!("{}: {e}", entry_path.display()))?;
        run("update-desktop-database", &[apps.as_os_str()]);
        changed = true;
    }
    if changed {
        run("xdg-mime", &[OsStr::new("default"), OsStr::new(handler), OsStr::new(WORKSPACE_MIME)]);
    }
    Ok(())
}

/// The desktop entry with `mime` in its `[Desktop Entry]` group's `MimeType=` list, or None when
/// it's there already. Other lines and groups stay as they are.
pub fn with_mime_type(entry: &str, mime: &str) -> Option<String> {
    let mut out = Vec::new();
    let (mut in_main, mut seen_main, mut done) = (false, false, false);
    for line in entry.lines() {
        let header = line.trim_start().starts_with('[');
        if header && in_main && !done {
            // At the end of the group, before the blank lines that set it off from the next.
            let blanks = out.iter().rev().take_while(|l: &&String| l.trim().is_empty()).count();
            out.insert(out.len() - blanks, format!("MimeType={mime};"));
            done = true;
        }
        if header {
            in_main = line.trim() == "[Desktop Entry]";
            seen_main |= in_main;
        }
        match line.strip_prefix("MimeType=") {
            Some(list) if in_main && !done => {
                if list.split(';').any(|m| m.trim() == mime) {
                    return None;
                }
                let list = list.trim_end();
                let sep = if list.is_empty() || list.ends_with(';') { "" } else { ";" };
                out.push(format!("MimeType={list}{sep}{mime};"));
                done = true;
            }
            _ => out.push(line.to_string()),
        }
    }
    if !seen_main {
        return None;
    }
    if !done {
        out.push(format!("MimeType={mime};"));
    }
    Some(out.join("\n") + "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The handler entry as tauri-plugin-deep-link 2.4 writes it (template.desktop).
    const HANDLER: &str = "[Desktop Entry]\nType=Application\nName=Breakpatch\nExec=\"/home/ana/.local/bin/breakpatch\" %u\nTerminal=false\nMimeType=x-scheme-handler/breakpatch\nNoDisplay=true\n";

    #[test]
    fn adds_the_workspace_type_to_the_handler_entry_once() {
        let once = with_mime_type(HANDLER, WORKSPACE_MIME).unwrap();
        assert!(once.contains("\nMimeType=x-scheme-handler/breakpatch;application/x-breakpatch-workspace;\n"), "{once}");
        assert!(once.contains("Exec=\"/home/ana/.local/bin/breakpatch\" %u\nTerminal=false\n"));
        assert_eq!(with_mime_type(&once, WORKSPACE_MIME), None);
        // As the plugin rewrites it (rust-ini, ";"-terminated list, the new type first).
        assert_eq!(with_mime_type("[Desktop Entry]\nMimeType=application/x-breakpatch-workspace;x-scheme-handler/breakpatch;\n", WORKSPACE_MIME), None);
    }

    #[test]
    fn adds_a_mime_type_line_to_the_main_group_only() {
        let entry = "[Desktop Entry]\nName=Breakpatch\n\n[Desktop Action New]\nName=New\nMimeType=text/plain\n";
        assert_eq!(
            with_mime_type(entry, WORKSPACE_MIME).unwrap(),
            "[Desktop Entry]\nName=Breakpatch\nMimeType=application/x-breakpatch-workspace;\n\n[Desktop Action New]\nName=New\nMimeType=text/plain\n"
        );
        assert_eq!(
            with_mime_type("[Desktop Entry]\nName=B\nMimeType=\n", WORKSPACE_MIME).unwrap(),
            "[Desktop Entry]\nName=B\nMimeType=application/x-breakpatch-workspace;\n"
        );
        assert_eq!(with_mime_type("not a desktop entry\n", WORKSPACE_MIME), None);
    }

    #[test]
    fn the_type_matches_the_file_association() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let assoc = &conf["bundle"]["fileAssociations"][0];
        assert_eq!(assoc["mimeType"], WORKSPACE_MIME);
        assert_eq!(assoc["ext"], serde_json::json!(["bpworkspace"]));
        assert!(MIME_XML.contains(r#"<mime-type type="application/x-breakpatch-workspace">"#));
        assert!(MIME_XML.contains(r#"<glob pattern="*.bpworkspace"/>"#));
    }

    #[test]
    fn registers_files_for_this_account_and_leaves_a_later_choice_alone() {
        let data = tempfile::tempdir().unwrap();
        let apps = data.path().join("applications");
        std::fs::create_dir_all(&apps).unwrap();
        std::fs::write(apps.join("breakpatch-handler.desktop"), HANDLER).unwrap();
        let mut ran: Vec<String> = Vec::new();
        let mut record = |cmd: &str, args: &[&OsStr]| {
            ran.push(std::iter::once(cmd.to_string()).chain(args.iter().map(|a| a.to_string_lossy().into_owned())).collect::<Vec<_>>().join(" "));
        };
        register_workspace_files(data.path(), "breakpatch-handler.desktop", &mut record).unwrap();
        let d = data.path().display();
        assert_eq!(
            ran,
            [
                format!("update-mime-database {d}/mime"),
                format!("update-desktop-database {d}/applications"),
                "xdg-mime default breakpatch-handler.desktop application/x-breakpatch-workspace".to_string(),
            ]
        );
        assert_eq!(std::fs::read_to_string(data.path().join("mime/packages/breakpatch.xml")).unwrap(), MIME_XML);
        let entry = std::fs::read_to_string(apps.join("breakpatch-handler.desktop")).unwrap();
        assert!(entry.contains(WORKSPACE_MIME));

        // The next start finds it all in place: no command, so no default is set again.
        ran.clear();
        let mut record = |cmd: &str, _: &[&OsStr]| ran.push(cmd.to_string());
        register_workspace_files(data.path(), "breakpatch-handler.desktop", &mut record).unwrap();
        assert!(ran.is_empty(), "{ran:?}");
    }

    #[test]
    fn says_so_when_the_handler_entry_is_missing() {
        let data = tempfile::tempdir().unwrap();
        let err = register_workspace_files(data.path(), "breakpatch-handler.desktop", &mut |_, _| {}).unwrap_err();
        assert!(err.contains("breakpatch-handler.desktop"), "{err}");
    }

    /// The definition is one update-mime-database accepts, and gives .bpworkspace files the type.
    #[test]
    #[ignore = "needs update-mime-database (shared-mime-info)"]
    fn update_mime_database_accepts_the_definition() {
        let data = tempfile::tempdir().unwrap();
        let pkg = data.path().join("mime/packages");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join(MIME_FILE), MIME_XML).unwrap();
        let out = std::process::Command::new("update-mime-database")
            .arg(data.path().join("mime"))
            .env("XDG_DATA_HOME", data.path()) // else it warns that the folder isn't searched
            .output()
            .unwrap();
        assert!(out.status.success() && out.stderr.is_empty(), "{}", String::from_utf8_lossy(&out.stderr));
        let globs = std::fs::read_to_string(data.path().join("mime/globs2")).unwrap();
        assert!(globs.lines().any(|l| l.ends_with(":application/x-breakpatch-workspace:*.bpworkspace")), "{globs}");
    }
}

//! Community's tests folder: the person's name for "saved by", and Show in Finder.
//! Reading and writing the folder goes through the fs plugin (scoped to picked folders).

use std::path::Path;
use std::process::Command;

/// The macOS full name ("Maria Lopez") from `id -F`; None elsewhere or when it's empty.
pub fn full_user_name() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = Command::new("/usr/bin/id").arg("-F").output().ok()?;
    if !out.status.success() {
        return None;
    }
    clean_name(&String::from_utf8_lossy(&out.stdout))
}

fn clean_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// Opens Finder with the folder selected. Only existing paths; nothing is run through a shell.
pub fn reveal(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("This folder isn't there any more.".into());
    }
    let status = if cfg!(target_os = "macos") {
        Command::new("/usr/bin/open").arg("-R").arg(path).status()
    } else if cfg!(target_os = "windows") {
        Command::new("explorer").arg(path).status()
    } else {
        Command::new("xdg-open").arg(path).status()
    };
    status.map(|_| ()).map_err(|e| format!("Couldn't open the folder: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_the_name_and_drops_an_empty_one() {
        assert_eq!(clean_name("Maria Lopez\n").as_deref(), Some("Maria Lopez"));
        assert_eq!(clean_name("  \n"), None);
    }

    #[test]
    fn refuses_a_missing_path() {
        assert!(reveal(Path::new("/definitely/not/here/breakpatch")).is_err());
    }
}

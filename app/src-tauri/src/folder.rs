//! Community's tests folder: the person's name for "saved by", and Show in Finder (or the
//! platform's file manager). Reading and writing the folder goes through the fs plugin (scoped to
//! picked folders).

use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::Command;

/// The person's full name ("Maria Lopez"), or None when the system has none or it's empty: macOS
/// from `id -F`, Linux from the account's GECOS field, Windows from the account's display name.
pub fn full_user_name() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = Command::new("/usr/bin/id").arg("-F").output().ok()?;
        if !out.status.success() {
            return None;
        }
        clean_name(&String::from_utf8_lossy(&out.stdout))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        gecos_name(&passwd_gecos()?)
    }
    #[cfg(windows)]
    {
        clean_name(&windows_display_name()?)
    }
    #[cfg(not(any(unix, windows)))]
    {
        None
    }
}

fn clean_name(raw: &str) -> Option<String> {
    let name = raw.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// The full name in a GECOS field: its first comma-separated part ("Maria Lopez,Room 4,,").
#[cfg_attr(not(any(test, all(unix, not(target_os = "macos")))), allow(dead_code))]
fn gecos_name(gecos: &str) -> Option<String> {
    clean_name(gecos.split(',').next().unwrap_or(""))
}

/// This user's GECOS field, from `getpwuid_r`.
#[cfg(all(unix, not(target_os = "macos")))]
fn passwd_gecos() -> Option<String> {
    use std::ffi::CStr;
    // SAFETY: passwd is a plain C struct; all-zero is a valid "empty" value for it.
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0u8; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: `pwd`, `buf` and `result` outlive the call, and `buf.len()` is its size.
    let rc = unsafe { libc::getpwuid_r(libc::getuid(), &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result) };
    if rc != 0 || result.is_null() || pwd.pw_gecos.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_gecos points at a NUL-terminated string in `buf`.
    Some(unsafe { CStr::from_ptr(pwd.pw_gecos) }.to_string_lossy().into_owned())
}

/// `GetUserNameExW(NameDisplay)`. A local account without a full name (or one Windows can't
/// map) gives None, and the app asks for the name instead.
#[cfg(windows)]
fn windows_display_name() -> Option<String> {
    use windows_sys::Win32::Security::Authentication::Identity::{GetUserNameExW, NameDisplay};
    let mut buf = [0u16; 256];
    let mut len = buf.len() as u32;
    // SAFETY: `len` is `buf`'s length in characters; on success it's the length written.
    if !unsafe { GetUserNameExW(NameDisplay, buf.as_mut_ptr(), &mut len) } {
        return None;
    }
    Some(String::from_utf16_lossy(&buf[..(len as usize).min(buf.len())]))
}

/// Shows the folder in the file manager, selected in its parent: Finder on macOS (`open -R`),
/// File Explorer on Windows (`explorer /select,`), and on Linux the file manager through
/// `org.freedesktop.FileManager1`, or the parent folder opened when there's none. Only existing
/// paths; nothing is run through a shell.
pub fn reveal(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("This folder isn't there any more.".into());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("/usr/bin/open")
            .arg("-R")
            .arg(path)
            .status()
            .map(|_| ())
            .map_err(|e| format!("Couldn't open the folder: {e}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| format!("Couldn't open the folder: {e}"))
    }
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
    fn the_full_name_is_the_first_part_of_gecos() {
        assert_eq!(gecos_name("María López,Room 4,555-0100,,").as_deref(), Some("María López"));
        assert_eq!(gecos_name("Build Bot").as_deref(), Some("Build Bot"));
        assert_eq!(gecos_name(",,,"), None);
        assert_eq!(gecos_name(""), None);
    }

    /// Whatever this machine's account says, it's never an empty or untrimmed name.
    #[test]
    fn this_users_full_name_is_clean_or_none() {
        if let Some(n) = full_user_name() {
            assert!(!n.is_empty() && n.trim() == n && !n.contains(','), "{n:?}");
        }
    }

    #[test]
    fn refuses_a_missing_path() {
        assert!(reveal(Path::new("/definitely/not/here/breakpatch")).is_err());
    }
}

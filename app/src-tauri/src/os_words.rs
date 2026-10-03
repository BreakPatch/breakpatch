//! The shell's messages in the words of the computer it runs on, as the app's
//! `app/src/lib/osWords.ts` does for the screens: messages are written for the Mac, and
//! [`os_text`] says "this PC" or "this computer", Credential Manager or keyring, File Explorer,
//! the Recycle Bin on Windows and Linux. On a Mac it hands back the very text it was given.
//! The rules are osWords.ts's, in the same order; change the two together.

use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Os {
    Mac,
    Windows,
    Linux,
}

impl Os {
    /// The system this shell was built for. Anything that isn't a Mac or Windows reads as Linux.
    pub const CURRENT: Os = if cfg!(target_os = "macos") {
        Os::Mac
    } else if cfg!(windows) {
        Os::Windows
    } else {
        Os::Linux
    };
}

/// Ordered: longer phrases before the words in them.
const WINDOWS: &[(&str, &str)] = &[
    ("This Mac's Keychain", "This PC's Credential Manager"),
    ("this Mac's Keychain", "this PC's Credential Manager"),
    ("the macOS Keychain", "Windows Credential Manager"),
    ("the Keychain", "Credential Manager"),
    ("Keychain", "Credential Manager"),
    ("Show in Finder", "Show in File Explorer"),
    ("in Finder", "in File Explorer"),
    ("Finder", "File Explorer"),
    ("the Trash", "the Recycle Bin"),
    ("Trash", "Recycle Bin"),
    ("Put Back", "Restore"),
    ("System Settings", "Windows Settings"),
    ("macOS", "Windows"),
    ("Apple silicon", "x64"),
    ("MacBook Pro", "PC"),
    ("Mac mini", "PC"),
    ("Macs", "PCs"),
    ("Mac", "PC"),
];

const LINUX: &[(&str, &str)] = &[
    ("This Mac's Keychain", "This computer's keyring"),
    ("this Mac's Keychain", "this computer's keyring"),
    ("the macOS Keychain", "your keyring"),
    ("the Keychain", "the keyring"),
    ("Keychain", "keyring"),
    ("Show in Finder", "Show in folder"),
    ("in Finder", "in your file manager"),
    ("Finder", "the file manager"),
    ("Put Back", "Restore"),
    ("System Settings", "your system settings"),
    ("macOS", "Linux"),
    ("Apple silicon", "x64"),
    ("MacBook Pro", "computer"),
    ("Mac mini", "computer"),
    ("Macs", "computers"),
    ("Mac", "computer"),
];

/// `text`, written for the Mac, in the words of the computer the shell runs on.
/// On a Mac: `text` itself, borrowed and unchanged.
pub fn os_text(text: &str) -> Cow<'_, str> {
    os_text_for(Os::CURRENT, text)
}

/// [`os_text`] for an owned message (a `format!`): on a Mac, the same `String` back.
pub fn os_string(text: String) -> String {
    match os_text_for(Os::CURRENT, &text) {
        Cow::Borrowed(_) => text,
        Cow::Owned(s) => s,
    }
}

/// [`os_text`] as on `os`.
pub fn os_text_for(os: Os, text: &str) -> Cow<'_, str> {
    let rules = match os {
        Os::Mac => return Cow::Borrowed(text),
        Os::Windows => WINDOWS,
        Os::Linux => LINUX,
    };
    let mut out = Cow::Borrowed(text);
    for (from, to) in rules {
        if let Some(changed) = replace_words(&out, from, to) {
            out = Cow::Owned(changed);
        }
    }
    out
}

/// `from` replaced by `to` where it stands as whole words (no letter, digit or `_` either side),
/// or None when it doesn't occur.
fn replace_words(text: &str, from: &str, to: &str) -> Option<String> {
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut out = String::new();
    let mut last = 0;
    let mut changed = false;
    for (at, _) in text.match_indices(from) {
        if at < last {
            continue;
        }
        let before = text[..at].chars().next_back();
        let after = text[at + from.len()..].chars().next();
        if word(before) || word(after) {
            continue;
        }
        out.push_str(&text[last..at]);
        out.push_str(to);
        last = at + from.len();
        changed = true;
    }
    if !changed {
        return None;
    }
    out.push_str(&text[last..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // The same samples as app/src/lib/osWords.test.ts, so the two say the same.
    const SAMPLES: &[&str] = &[
        "Passwords and emails that tests type in. Values stay in this Mac's Keychain and are never uploaded.",
        "Couldn't save to the Keychain. Try again.",
        "This Mac has 16 GB of memory, so you get the Standard AI assistant.",
        "Your Solo licence is in use on another Mac.",
        "Saved secrets stay on each Mac. Add it here once and every test that uses it can run.",
        "Show in Finder",
        "Breakpatch moved the copy to the Trash. To undo it, use Put Back.",
        "macOS isn't letting Breakpatch show notifications",
        "In System Settings, open Notifications, then Breakpatch, and turn on Allow notifications.",
        "Your seat is already used on too many Macs.",
        "That key copy was signed by a Mac this Mac doesn't trust, so it doesn't take it.",
    ];

    #[test]
    fn the_mac_gets_the_very_same_text() {
        for s in SAMPLES {
            let out = os_text_for(Os::Mac, s);
            assert!(matches!(out, Cow::Borrowed(b) if std::ptr::eq(b, *s)), "{s}");
        }
        let owned = String::from("This Mac's clock is behind.");
        let at = owned.as_ptr();
        if Os::CURRENT == Os::Mac {
            let same = os_string(owned);
            assert_eq!(same.as_ptr(), at);
        }
    }

    #[test]
    fn windows_says_pc_credential_manager_and_the_recycle_bin() {
        let w: Vec<String> = SAMPLES.iter().map(|s| os_text_for(Os::Windows, s).into_owned()).collect();
        assert_eq!(w[0], "Passwords and emails that tests type in. Values stay in this PC's Credential Manager and are never uploaded.");
        assert_eq!(w[1], "Couldn't save to Credential Manager. Try again.");
        assert_eq!(w[2], "This PC has 16 GB of memory, so you get the Standard AI assistant.");
        assert_eq!(w[3], "Your Solo licence is in use on another PC.");
        assert_eq!(w[5], "Show in File Explorer");
        assert_eq!(w[6], "Breakpatch moved the copy to the Recycle Bin. To undo it, use Restore.");
        assert_eq!(w[7], "Windows isn't letting Breakpatch show notifications");
        assert_eq!(w[8], "In Windows Settings, open Notifications, then Breakpatch, and turn on Allow notifications.");
        assert_eq!(w[9], "Your seat is already used on too many PCs.");
        assert_eq!(w[10], "That key copy was signed by a PC this PC doesn't trust, so it doesn't take it.");
    }

    #[test]
    fn linux_says_computer_keyring_and_keeps_the_trash() {
        let l: Vec<String> = SAMPLES.iter().map(|s| os_text_for(Os::Linux, s).into_owned()).collect();
        assert_eq!(l[0], "Passwords and emails that tests type in. Values stay in this computer's keyring and are never uploaded.");
        assert_eq!(l[1], "Couldn't save to the keyring. Try again.");
        assert_eq!(l[2], "This computer has 16 GB of memory, so you get the Standard AI assistant.");
        assert_eq!(l[5], "Show in folder");
        assert_eq!(l[6], "Breakpatch moved the copy to the Trash. To undo it, use Restore.");
        assert_eq!(l[8], "In your system settings, open Notifications, then Breakpatch, and turn on Allow notifications.");
        assert_eq!(l[9], "Your seat is already used on too many computers.");
    }

    #[test]
    fn leaves_no_mac_words_and_only_whole_words() {
        for os in [Os::Windows, Os::Linux] {
            for s in SAMPLES {
                let out = os_text_for(os, s);
                for w in ["Mac", "Macs", "Keychain", "Finder", "macOS", "System Settings"] {
                    assert!(replace_words(&out, w, "").is_none(), "{os:?}: {out}");
                }
            }
            assert_eq!(os_text_for(os, "MacBook-free machine, MACHINE_KEY, Macro, iMac"), "MacBook-free machine, MACHINE_KEY, Macro, iMac");
        }
        assert_eq!(os_text_for(Os::Linux, "Office Mac mini"), "Office computer");
        assert_eq!(os_text_for(Os::Windows, "Mac."), "PC.");
    }
}

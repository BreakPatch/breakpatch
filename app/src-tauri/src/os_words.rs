//! The shell's messages in the words of the computer it runs on, as the app's
//! `app/src/lib/osWords.ts` does for the screens: messages are written for the Mac, and
//! [`os_text`] says "this PC", Credential Manager or keyring, File Explorer,
//! the Recycle Bin on Windows and Linux. On a Mac it hands back the very text it was given.
//! The rules are osWords.ts's, in the same order; change the two together.
//!
//! [`os_text`] is for the message's own words only. A message with values in it (a secret's,
//! site's or workspace's name, an error) is made with [`os_format!`], which rewrites the format
//! string and never the values: a secret called "Mac tests" stays "Mac tests" on Windows.

use std::borrow::Cow;
use std::fmt;

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

    /// The system as a message names it when it refused something: "macOS refused it".
    pub const fn name(self) -> &'static str {
        match self {
            Os::Mac => "macOS",
            Os::Windows => "Windows",
            Os::Linux => "the system",
        }
    }

    /// Where deleted files go: "move it to the Trash" (the Recycle Bin on Windows).
    pub const fn trash(self) -> &'static str {
        match self {
            Os::Windows => "the Recycle Bin",
            Os::Mac | Os::Linux => "the Trash",
        }
    }
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
    ("This Mac's Keychain", "This PC's keyring"),
    ("this Mac's Keychain", "this PC's keyring"),
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
    ("MacBook Pro", "PC"),
    ("Mac mini", "PC"),
    ("Macs", "PCs"),
    ("Mac", "PC"),
];

/// `text`, written for the Mac, in the words of the computer the shell runs on.
/// On a Mac: `text` itself, borrowed and unchanged.
pub fn os_text(text: &str) -> Cow<'_, str> {
    os_text_for(Os::CURRENT, text)
}

/// `format!` for a message written for the Mac, in the words of the computer the shell runs on:
/// the format string's words are rewritten as [`os_text`] does, the values are left as they are.
/// On a Mac it is `format!` itself.
///
/// Values are passed explicitly, all by name (`os_format!("No {name} on this Mac.", name = n)`)
/// or all by position (`{}`), never captured from the format string (`{name}` with no `name =`):
/// a captured value can't be told from the message's words, so that doesn't compile.
macro_rules! os_format {
    ($($args:tt)*) => {
        $crate::os_words::os_format_for!($crate::os_words::Os::CURRENT; $($args)*)
    };
}
pub(crate) use os_format;

/// [`os_format!`] as on the given [`Os`] (`os_format_for!(Os::Windows; "…", …)`).
macro_rules! os_format_for {
    ($os:expr; $fmt:literal $(, $name:ident = $val:expr)+ $(,)?) => {{
        const _: () = assert!(
            $crate::os_words::names_only($fmt, &[$(stringify!($name)),+]),
            "os_format!: pass every value in the message as name = value"
        );
        match $os {
            $crate::os_words::Os::Mac => format!($fmt $(, $name = $val)+),
            os => $crate::os_words::os_formatted(os, &format!($fmt $(, $name = $crate::os_words::Value(&$val))+)),
        }
    }};
    ($os:expr; $fmt:literal $(, $val:expr)* $(,)?) => {{
        const _: () = assert!(
            $crate::os_words::names_only($fmt, &[]),
            "os_format!: pass every value in the message as name = value"
        );
        match $os {
            $crate::os_words::Os::Mac => format!($fmt $(, $val)*),
            os => $crate::os_words::os_formatted(os, &format!($fmt $(, $crate::os_words::Value(&$val))*)),
        }
    }};
}
pub(crate) use os_format_for;

/// Marks where a value starts and ends in a message [`os_format!`] made, until [`os_formatted`]
/// takes them out again (private-use characters, not in any message's words or anyone's names; a
/// value that has them anyway loses them).
const VALUE_START: char = '\u{F0000}';
const VALUE_END: char = '\u{F0001}';

/// A value in an [`os_format!`] message: written as it would be, between the markers.
#[doc(hidden)]
pub struct Value<'a, T: ?Sized>(pub &'a T);

impl<T: fmt::Display + ?Sized> fmt::Display for Value<'_, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use fmt::Write;
        f.write_char(VALUE_START)?;
        fmt::Display::fmt(self.0, f)?;
        f.write_char(VALUE_END)
    }
}

impl<T: fmt::Debug + ?Sized> fmt::Debug for Value<'_, T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use fmt::Write;
        f.write_char(VALUE_START)?;
        fmt::Debug::fmt(self.0, f)?;
        f.write_char(VALUE_END)
    }
}

/// A message [`os_format!`] made with marked values: its words in `os`'s words, its values as they were.
#[doc(hidden)]
pub fn os_formatted(os: Os, marked: &str) -> String {
    // The words with a VALUE_START where each value goes (not a letter, so a word next to a
    // value is still a whole word), and the values in order.
    let mut words = String::with_capacity(marked.len());
    let mut values: Vec<String> = Vec::new();
    let mut depth = 0usize;
    for c in marked.chars() {
        match c {
            VALUE_START => {
                if depth == 0 {
                    words.push(VALUE_START);
                    values.push(String::new());
                } else {
                    values.last_mut().expect("a value").push(c);
                }
                depth += 1;
            }
            VALUE_END if depth > 0 => {
                depth -= 1;
                if depth > 0 {
                    values.last_mut().expect("a value").push(c);
                }
            }
            _ if depth > 0 => values.last_mut().expect("a value").push(c),
            _ => words.push(c),
        }
    }
    let words = os_text_for(os, &words);
    let mut out = String::with_capacity(words.len() + values.iter().map(String::len).sum::<usize>());
    let mut values = values.into_iter();
    for c in words.chars() {
        match c {
            VALUE_START => out.push_str(&values.next().unwrap_or_default()),
            _ => out.push(c),
        }
    }
    out
}

/// Whether every value `fmt` names is in `names` (an `{x}` that isn't would be captured, unmarked).
#[doc(hidden)]
pub const fn names_only(fmt: &str, names: &[&str]) -> bool {
    let b = fmt.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'{' {
            if i + 1 < b.len() && b[i + 1] == b'{' {
                i += 2;
                continue;
            }
            let start = i + 1;
            let mut end = start;
            while end < b.len() && b[end] != b'}' && b[end] != b':' {
                end += 1;
            }
            if end > start && !b[start].is_ascii_digit() && !listed(b, start, end, names) {
                return false;
            }
            i = end;
        } else {
            i += 1;
        }
    }
    true
}

const fn listed(b: &[u8], start: usize, end: usize, names: &[&str]) -> bool {
    let mut k = 0;
    while k < names.len() {
        let n = names[k].as_bytes();
        if n.len() == end - start {
            let mut m = 0;
            while m < n.len() && n[m] == b[start + m] {
                m += 1;
            }
            if m == n.len() {
                return true;
            }
        }
        k += 1;
    }
    false
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
    }

    #[test]
    fn os_format_on_a_mac_is_format_itself() {
        let (name, n) = ("Mac tests", 3);
        assert_eq!(os_format_for!(Os::Mac; "No {name} on this Mac ({n:>2}).", name = name, n = n), format!("No {name} on this Mac ({n:>2})."));
        assert_eq!(os_format_for!(Os::Mac; "{} on this Mac: {:?}", name, "Keychain"), "Mac tests on this Mac: \"Keychain\"");
        if Os::CURRENT == Os::Mac {
            assert_eq!(os_format!("There's no saved secret {name} on this Mac.", name = name), "There's no saved secret Mac tests on this Mac.");
        }
    }

    #[test]
    fn os_format_rewrites_the_words_and_never_the_values() {
        let name = "Mac tests";
        for (os, want) in [
            (Os::Windows, "There's no saved secret Mac tests on this PC. Check the Keychain value: Finder Trash"),
            (Os::Linux, "There's no saved secret Mac tests on this PC. Check the Keychain value: Finder Trash"),
        ] {
            let named = os_format_for!(os; "There's no saved secret {name} on this Mac. Check the {what} value: {rest}", name = name, what = "Keychain", rest = "Finder Trash");
            assert_eq!(named, want, "{os:?}");
            let positional = os_format_for!(os; "There's no saved secret {} on this Mac. Check the {} value: {}", name, "Keychain", "Finder Trash");
            assert_eq!(positional, want, "{os:?}");
        }
        // Words around a value are still whole words; a phrase with no value in it still matches.
        assert_eq!(os_format_for!(Os::Windows; "{n} Macs, {who}'s Mac, this Mac's Keychain", n = 2, who = "Ana"), "2 PCs, Ana's PC, this PC's Credential Manager");
        assert_eq!(os_format_for!(Os::Linux; "In the Trash: {what}", what = "the Trash"), "In the Trash: the Trash");
        // Formatting options apply to the value; the markers never show.
        assert_eq!(os_format_for!(Os::Windows; "[{n:>4}] [{s:?}] on this Mac", n = 7, s = "Mac"), "[   7] [\"Mac\"] on this PC");
        // A value holding the markers themselves (private-use characters no name has) loses them,
        // and nothing else: the markers never show, the other values and the words are as they'd be.
        let odd = format!("a{VALUE_END}b{VALUE_START}c");
        assert_eq!(os_format_for!(Os::Windows; "{odd} on this Mac, {name}", odd = odd, name = name), "abc on this PC, Mac tests");
    }

    #[test]
    fn os_format_takes_only_values_it_was_given() {
        assert!(names_only("{name} on this Mac {{literal}} {0} {} {n:>3}", &["name", "n"]));
        assert!(!names_only("{name} and {other}", &["name"]));
        assert!(!names_only("{captured}", &[]));
        assert!(names_only("no values", &[]));
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
    fn linux_says_pc_keyring_and_keeps_the_trash() {
        let l: Vec<String> = SAMPLES.iter().map(|s| os_text_for(Os::Linux, s).into_owned()).collect();
        assert_eq!(l[0], "Passwords and emails that tests type in. Values stay in this PC's keyring and are never uploaded.");
        assert_eq!(l[1], "Couldn't save to the keyring. Try again.");
        assert_eq!(l[2], "This PC has 16 GB of memory, so you get the Standard AI assistant.");
        assert_eq!(l[5], "Show in folder");
        assert_eq!(l[6], "Breakpatch moved the copy to the Trash. To undo it, use Restore.");
        assert_eq!(l[8], "In your system settings, open Notifications, then Breakpatch, and turn on Allow notifications.");
        assert_eq!(l[9], "Your seat is already used on too many PCs.");
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
        assert_eq!(os_text_for(Os::Linux, "Office Mac mini"), "Office PC");
        assert_eq!(os_text_for(Os::Windows, "Mac."), "PC.");
    }
}

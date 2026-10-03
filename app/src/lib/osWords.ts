// The words that depend on the computer Breakpatch runs on: "this Mac" is "this PC" on Windows and
// Linux; Finder, the Keychain, the Trash and ⌘ have their own names there.
//
// On a Mac every helper returns exactly the text it was given, so the Mac app reads as it always
// has. The text in the code is the Mac's; `osText` rewrites it for Windows and Linux.
//
// No import of platform.ts on purpose: many tests mock that module whole.

export type Os = 'mac' | 'windows' | 'linux';

let forced: Os | null = null;

/** Tests only: pretend to run on `os` (null: back to the real one). */
export function setOsForTests(os: Os | null): void { forced = os; }

/** The system from a webview's user agent: WKWebView says Macintosh, WebView2 Windows, WebKitGTK
 *  X11 or Linux. Anything unknown is the Mac, the app's first home. */
export function osFromUserAgent(ua: string): Os {
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux|X11|BSD/i.test(ua)) return 'linux';
  return 'mac';
}

/** The computer the desktop app runs on. In a plain browser (the demo, the tests) it's the Mac, so
 *  the preview and every existing test read the Mac's words. */
export function currentOs(): Os {
  if (forced) return forced;
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  if (!desktop || typeof navigator === 'undefined') return 'mac';
  return osFromUserAgent(navigator.userAgent);
}

export function isMac(): boolean { return currentOs() === 'mac'; }

// Ordered: longer phrases before the words in them. `$1` keeps a leading capital where there is one.
type Rule = [RegExp, string];
const COMMON_FIRST: Rule[] = [
  [/⌘\s?/g, 'Ctrl+'],
];
const WINDOWS: Rule[] = [
  ...COMMON_FIRST,
  [/\b([Tt])his Mac's Keychain\b/g, '$1his PC\'s Credential Manager'],
  [/\bthe macOS Keychain\b/g, 'Windows Credential Manager'],
  [/\bthe Keychain\b/g, 'Credential Manager'],
  [/\bKeychain\b/g, 'Credential Manager'],
  [/\bShow in Finder\b/g, 'Show in File Explorer'],
  [/\bin Finder\b/g, 'in File Explorer'],
  [/\bFinder\b/g, 'File Explorer'],
  [/\bthe Trash\b/g, 'the Recycle Bin'],
  [/\bTrash\b/g, 'Recycle Bin'],
  [/\bPut Back\b/g, 'Restore'],
  [/\bSystem Settings\b/g, 'Windows Settings'],
  [/\bmacOS\b/g, 'Windows'],
  [/\bApple silicon\b/g, 'x64'],
  [/\bMacBook Pro\b/g, 'PC'],
  [/\bMac mini\b/g, 'PC'],
  [/\bMacs\b/g, 'PCs'],
  [/\bMac\b/g, 'PC'],
];
const LINUX: Rule[] = [
  ...COMMON_FIRST,
  [/\b([Tt])his Mac's Keychain\b/g, '$1his PC\'s keyring'],
  [/\bthe macOS Keychain\b/g, 'your keyring'],
  [/\bthe Keychain\b/g, 'the keyring'],
  [/\bKeychain\b/g, 'keyring'],
  [/\bShow in Finder\b/g, 'Show in folder'],
  [/\bin Finder\b/g, 'in your file manager'],
  [/\bFinder\b/g, 'the file manager'],
  [/\bPut Back\b/g, 'Restore'],
  [/\bSystem Settings\b/g, 'your system settings'],
  [/\bmacOS\b/g, 'Linux'],
  [/\bApple silicon\b/g, 'x64'],
  [/\bMacBook Pro\b/g, 'PC'],
  [/\bMac mini\b/g, 'PC'],
  [/\bMacs\b/g, 'PCs'],
  [/\bMac\b/g, 'PC'],
];

/** `text`, written for the Mac, in the words of the computer it runs on. Unchanged on a Mac. */
export function osText(text: string, os: Os = currentOs()): string {
  if (os === 'mac') return text;
  let out = text;
  for (const [re, to] of os === 'windows' ? WINDOWS : LINUX) out = out.replace(re, to);
  return out;
}

/** "this Mac" or "this PC". */
export function thisComputer(os: Os = currentOs()): string { return osText('this Mac', os); }
/** "This Mac" or "This PC". */
export function ThisComputer(os: Os = currentOs()): string { return osText('This Mac', os); }

/** "Mac" or "PC", as in "Maria's Mac". */
export function computer(os: Os = currentOs()): string { return osText('Mac', os); }
/** "Mac", "PC" or "Computer", to start a line with. */
export function Computer(os: Os = currentOs()): string { const w = computer(os); return w[0].toUpperCase() + w.slice(1); }

/** The Trash: "the Trash", or "the Recycle Bin" on Windows. */
export function theTrash(os: Os = currentOs()): string { return osText('the Trash', os); }

/** Show in Finder: the button that opens the file manager on a folder. */
export function showInFileManager(os: Os = currentOs()): string { return osText('Show in Finder', os); }

/** A keyboard shortcut as the person types it: ⌘E on a Mac, Ctrl+E elsewhere. */
export function shortcut(key: string, os: Os = currentOs()): string { return osText(`⌘${key}`, os); }

/** Whether the app's shortcut key is down: ⌘ on a Mac, Ctrl elsewhere. */
export function shortcutKeyDown(e: { metaKey: boolean; ctrlKey: boolean }, os: Os = currentOs()): boolean {
  return os === 'mac' ? e.metaKey : e.ctrlKey;
}

/** Whether the other one of ⌘ and Ctrl is down too (Ctrl on a Mac, ⌘ or the Windows key elsewhere). */
export function otherCommandKeyDown(e: { metaKey: boolean; ctrlKey: boolean }, os: Os = currentOs()): boolean {
  return os === 'mac' ? e.ctrlKey : e.metaKey;
}

/** `aria-keyshortcuts` for the app's shortcut key and `key`: "Meta+N" on a Mac, "Control+N" elsewhere. */
export function ariaShortcut(key: string, os: Os = currentOs()): string {
  return `${os === 'mac' ? 'Meta' : 'Control'}+${key}`;
}

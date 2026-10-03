// The words for the computer the app runs on (osWords.ts): the Mac's text is never changed, and
// Windows and Linux get their own names for the computer, Finder, the Keychain, the Trash and ⌘.
import { afterEach, describe, expect, it } from 'vitest';
import {
  ariaShortcut, Computer, computer, currentOs, osFromUserAgent, osText, otherCommandKeyDown, setOsForTests,
  shortcut, shortcutKeyDown, showInFileManager, theTrash, ThisComputer, thisComputer,
} from './osWords';

afterEach(() => setOsForTests(null));

// Text from the app, as written for the Mac.
const SAMPLES = [
  "Passwords and emails that tests type in. Values stay in this Mac's Keychain and are never uploaded.",
  "Couldn't save to the Keychain. Try again.",
  'This Mac has 16 GB of memory, so you get the Standard AI assistant.',
  "Your Solo licence is in use on another Mac.",
  'Saved secrets stay on each Mac. Add it here once and every test that uses it can run.',
  'Show in Finder',
  "Breakpatch moved the copy to the Trash. To undo it, use Put Back.",
  "macOS isn't letting Breakpatch show notifications",
  'In System Settings, open Notifications, then Breakpatch, and turn on Allow notifications.',
  'Use the page directly, without recording (⌘E)',
  "That’s how active Macs are counted without any ID.",
  'A local runner Mac with 32 GB of memory or more can also download a larger one.',
];

describe('osText', () => {
  it('leaves every Mac text exactly as it is', () => {
    for (const s of SAMPLES) expect(osText(s, 'mac')).toBe(s);
  });

  it('says PC, Credential Manager, File Explorer and the Recycle Bin on Windows', () => {
    const w = SAMPLES.map(s => osText(s, 'windows'));
    expect(w[0]).toBe("Passwords and emails that tests type in. Values stay in this PC's Credential Manager and are never uploaded.");
    expect(w[1]).toBe("Couldn't save to Credential Manager. Try again.");
    expect(w[2]).toBe('This PC has 16 GB of memory, so you get the Standard AI assistant.');
    expect(w[3]).toBe('Your Solo licence is in use on another PC.');
    expect(w[4]).toBe('Saved secrets stay on each PC. Add it here once and every test that uses it can run.');
    expect(w[5]).toBe('Show in File Explorer');
    expect(w[6]).toBe('Breakpatch moved the copy to the Recycle Bin. To undo it, use Restore.');
    expect(w[7]).toBe("Windows isn't letting Breakpatch show notifications");
    expect(w[8]).toBe('In Windows Settings, open Notifications, then Breakpatch, and turn on Allow notifications.');
    expect(w[9]).toBe('Use the page directly, without recording (Ctrl+E)');
    expect(w[10]).toBe('That’s how active PCs are counted without any ID.');
  });

  it('says PC, keyring and the file manager on Linux, and keeps the Trash', () => {
    const l = SAMPLES.map(s => osText(s, 'linux'));
    expect(l[0]).toBe("Passwords and emails that tests type in. Values stay in this PC's keyring and are never uploaded.");
    expect(l[1]).toBe("Couldn't save to the keyring. Try again.");
    expect(l[2]).toBe('This PC has 16 GB of memory, so you get the Standard AI assistant.');
    expect(l[3]).toBe('Your Solo licence is in use on another PC.');
    expect(l[5]).toBe('Show in folder');
    expect(l[6]).toBe('Breakpatch moved the copy to the Trash. To undo it, use Restore.');
    expect(l[7]).toBe("Linux isn't letting Breakpatch show notifications");
    expect(l[8]).toBe('In your system settings, open Notifications, then Breakpatch, and turn on Allow notifications.');
    expect(l[9]).toBe('Use the page directly, without recording (Ctrl+E)');
    expect(l[11]).toBe('A local runner PC with 32 GB of memory or more can also download a larger one.');
  });

  it('leaves no Mac words behind on Windows or Linux', () => {
    for (const os of ['windows', 'linux'] as const) {
      for (const s of SAMPLES) expect(osText(s, os)).not.toMatch(/\bMacs?\b|Finder|Keychain|macOS|System Settings|⌘/);
    }
  });

  it('names a Mac mini as a plain PC or computer', () => {
    expect(osText('Like "Office Mac mini". Runs show under this name.', 'windows')).toBe('Like "Office PC". Runs show under this name.');
    expect(osText('Office Mac mini', 'linux')).toBe('Office PC');
  });

  it('leaves words that only contain "Mac" alone', () => {
    expect(osText('MacBook-free machine, MACHINE_KEY, Macro', 'windows')).toBe('MacBook-free machine, MACHINE_KEY, Macro');
  });
});

describe('the helpers', () => {
  it('name this computer, the Trash, the file manager and shortcuts per system', () => {
    expect([thisComputer('mac'), thisComputer('windows'), thisComputer('linux')]).toEqual(['this Mac', 'this PC', 'this PC']);
    expect([ThisComputer('mac'), ThisComputer('windows'), ThisComputer('linux')]).toEqual(['This Mac', 'This PC', 'This PC']);
    expect([computer('mac'), computer('windows'), computer('linux')]).toEqual(['Mac', 'PC', 'PC']);
    expect(Computer('linux')).toBe('PC');
    expect([theTrash('mac'), theTrash('windows'), theTrash('linux')]).toEqual(['the Trash', 'the Recycle Bin', 'the Trash']);
    expect([showInFileManager('mac'), showInFileManager('windows'), showInFileManager('linux')])
      .toEqual(['Show in Finder', 'Show in File Explorer', 'Show in folder']);
    expect([shortcut('E', 'mac'), shortcut('E', 'windows')]).toEqual(['⌘E', 'Ctrl+E']);
    expect([ariaShortcut('N', 'mac'), ariaShortcut('N', 'linux')]).toEqual(['Meta+N', 'Control+N']);
  });

  it('take ⌘ on a Mac and Ctrl elsewhere', () => {
    const cmd = { metaKey: true, ctrlKey: false }, ctrl = { metaKey: false, ctrlKey: true };
    expect(shortcutKeyDown(cmd, 'mac')).toBe(true);
    expect(shortcutKeyDown(ctrl, 'mac')).toBe(false);
    expect(shortcutKeyDown(ctrl, 'windows')).toBe(true);
    expect(shortcutKeyDown(cmd, 'linux')).toBe(false);
    expect(otherCommandKeyDown(ctrl, 'mac')).toBe(true);
    expect(otherCommandKeyDown(cmd, 'linux')).toBe(true);
  });
});

describe('currentOs', () => {
  it('reads the webview from its user agent', () => {
    expect(osFromUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)')).toBe('mac');
    expect(osFromUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('windows');
    expect(osFromUserAgent('Mozilla/5.0 (X11; Ubuntu; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('linux');
    expect(osFromUserAgent('something else')).toBe('mac');
  });

  it('is the Mac in a plain browser, whatever the browser runs on, unless a test says otherwise', () => {
    expect(currentOs()).toBe('mac');
    setOsForTests('windows');
    expect(currentOs()).toBe('windows');
    expect(thisComputer()).toBe('this PC');
  });
});

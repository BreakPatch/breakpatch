// Paste buttons read the clipboard through the shell in the app, so macOS never shows WebKit's
// "Paste" bubble; in a browser they use navigator.clipboard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyTextSoon, readClipboard } from '../platform';
import cargo from '../../src-tauri/Cargo.toml?raw';
import capability from '../../src-tauri/capabilities/default.json';
import lib from '../../src-tauri/src/lib.rs?raw';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.doUnmock('@tauri-apps/api/core'); });

describe('readClipboard', () => {
  it('in the app, asks the shell and never the webview', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const invoke = vi.fn(async () => 'const firebaseConfig = {}');
    vi.doMock('@tauri-apps/api/core', () => ({ invoke }));
    const web = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { readText: web } });
    expect(await readClipboard()).toBe('const firebaseConfig = {}');
    expect(invoke).toHaveBeenCalledWith('plugin:clipboard-manager|read_text', undefined);
    expect(web).not.toHaveBeenCalled();
  });

  it('in a browser, uses navigator.clipboard, and says null when it may not', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: async () => 'hello' } });
    expect(await readClipboard()).toBe('hello');
    vi.stubGlobal('navigator', { clipboard: { readText: async () => { throw new Error('not allowed'); } } });
    expect(await readClipboard()).toBeNull();
  });

  it('the shell has the clipboard plugin, allowed to read text only', () => {
    expect(cargo).toMatch(/^tauri-plugin-clipboard-manager = "2"$/m);
    expect(lib).toContain('.plugin(tauri_plugin_clipboard_manager::init())');
    expect(capability.permissions).toContain('clipboard-manager:allow-read-text');
    expect(capability.permissions.filter(p => p.startsWith('clipboard-manager:'))).toEqual(['clipboard-manager:allow-read-text']);
  });
});

describe('copyTextSoon', () => {
  it('starts the write at once, with the text to come, where the webview has ClipboardItem', async () => {
    const written: Blob[] = [];
    class Item { items: Record<string, Promise<Blob>>; constructor(items: Record<string, Promise<Blob>>) { this.items = items; } }
    vi.stubGlobal('ClipboardItem', Item);
    const write = vi.fn(async (items: Item[]) => { written.push(await items[0]!.items['text/plain']!); });
    vi.stubGlobal('navigator', { clipboard: { write, writeText: vi.fn() } });
    let give!: (t: string) => void;
    const done = copyTextSoon(new Promise<string>(r => { give = r; }));
    expect(write).toHaveBeenCalledTimes(1);                            // before the text is known
    give('breakpatch://open?ws=demo&path=suites/s1');
    await done;
    expect(await written[0]!.text()).toBe('breakpatch://open?ws=demo&path=suites/s1');
  });

  it('copies once the text is known where it hasn’t, and says when the text can’t be had', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyTextSoon(Promise.resolve('x'));
    expect(writeText).toHaveBeenCalledWith('x');
    await expect(copyTextSoon(Promise.reject(new Error('Rename its file')))).rejects.toThrow('Rename its file');
    class Item { items: Record<string, Promise<Blob>>; constructor(items: Record<string, Promise<Blob>>) { this.items = items; } }
    vi.stubGlobal('ClipboardItem', Item);
    vi.stubGlobal('navigator', { clipboard: { write: async (i: Item[]) => { await i[0]!.items['text/plain']; }, writeText } });
    await expect(copyTextSoon(Promise.reject(new Error('Rename its file')))).rejects.toThrow('Rename its file');
  });
});

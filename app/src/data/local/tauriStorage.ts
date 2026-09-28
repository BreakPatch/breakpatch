// FolderStorage over @tauri-apps/plugin-fs. Access is limited to the fs scope: the folder
// the person picked in the dialog (added recursively) and, after a restart, the same folders
// restored by tauri-plugin-persisted-scope.
import { checkSize, FileTooBig, MAX_FILE_BYTES, type DirEntry, type FolderStorage } from './storage';

type Fs = typeof import('@tauri-apps/plugin-fs');
let fsp: Promise<Fs> | undefined;
const fs = () => (fsp ??= import('@tauri-apps/plugin-fs'));

export class TauriStorage implements FolderStorage {
  async read(path: string) {
    const f = await fs();
    if (!(await f.exists(path))) return null;
    // The size first: a huge file (a mistake, or a test folder someone booby-trapped) is never read.
    if ((await f.stat(path)).size > MAX_FILE_BYTES) throw new FileTooBig(path);
    return checkSize(path, await f.readTextFile(path));
  }
  async write(path: string, text: string) { await (await fs()).writeTextFile(path, text); }
  async list(dir: string): Promise<DirEntry[]> {
    const f = await fs();
    if (!(await f.exists(dir))) return [];
    const entries = await f.readDir(dir);
    return entries.map(e => ({ name: e.name, isDir: e.isDirectory })).sort((a, b) => a.name.localeCompare(b.name));
  }
  async mkdir(dir: string) { await (await fs()).mkdir(dir, { recursive: true }); }
  async rename(from: string, to: string) { await (await fs()).rename(from, to); }
  async remove(path: string) {
    const f = await fs();
    if (await f.exists(path)) await f.remove(path, { recursive: true });
  }
  async exists(path: string) { return (await fs()).exists(path); }
  async watch(dir: string, cb: () => void) {
    // Needs the fs plugin's "watch" feature; if it's missing the backend falls back to polling.
    const off = await (await fs()).watch(dir, () => cb(), { recursive: true, delayMs: 400 });
    return () => { off(); };
  }
}

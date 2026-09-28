// File access for the local backend. Two implementations: Tauri's fs plugin on the Mac
// (tauriStorage.ts) and this in-memory one (unit tests and the browser preview).
// Paths are absolute, '/'-separated strings.

export interface DirEntry { name: string; isDir: boolean }

/** Test, app and suite files are small: anything bigger isn't read at all (security review L2). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** A file over MAX_FILE_BYTES. The local backend skips it and says so. */
export class FileTooBig extends Error {
  readonly path: string;
  constructor(path: string) { super(`${baseName(path)} is bigger than 5 MB, so it isn't read.`); this.path = path; }
}

/** Throws FileTooBig for text over the limit (for storages that can only tell after reading). */
export function checkSize(path: string, text: string | null): string | null {
  if (text !== null && text.length > MAX_FILE_BYTES) throw new FileTooBig(path);
  return text;
}

export interface FolderStorage {
  /** The file's text, or null when it doesn't exist. Throws FileTooBig over MAX_FILE_BYTES. */
  read(path: string): Promise<string | null>;
  write(path: string, text: string): Promise<void>;
  /** Entries of a folder; [] when it doesn't exist. */
  list(dir: string): Promise<DirEntry[]>;
  /** Creates the folder and any missing parents. */
  mkdir(dir: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Removes a file, or a folder with everything in it. Missing paths are fine. */
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  /** Optional: calls `cb` after changes under `dir` (debounced by the implementation). */
  watch?(dir: string, cb: () => void): Promise<() => void>;
}

export function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/{2,}/g, '/');
}

/**
 * A temporary file's name next to `name`, for writing then renaming into place. It never starts
 * with a dot: Tauri's fs scope (requireLiteralLeadingDot, on by default on macOS) refuses dot
 * files even inside a picked folder, so a hidden temp file made every save fail there.
 */
export function tempName(name: string): string {
  return `${name}.bp-${Math.random().toString(36).slice(2, 8)}.tmp`;
}

/** A name tempName made. Such files are ours, half written, and never listed as content. */
export function isTempName(name: string): boolean { return /\.bp-[a-z0-9]+\.tmp$/.test(name); }

export function baseName(path: string): string {
  const p = path.replace(/[\\/]+$/, '');
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1) || p;
}

function parentOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '/' : path.slice(0, i);
}

export interface MemoryOptions {
  /** Keep the files in localStorage under this key, so they survive a reload (dev flag `?keepfiles`). */
  persistKey?: string;
  /** Folders that refuse writes (to test "folder not writable"). */
  readOnly?: string[];
}

/** Files in memory. Folders are implied by the files in them, plus the ones made with mkdir. */
export class MemoryStorage implements FolderStorage {
  private files = new Map<string, string>();
  private dirs = new Set<string>(['/']);
  private watchers = new Set<{ dir: string; cb: () => void }>();
  private opts: MemoryOptions;

  constructor(opts: MemoryOptions = {}) {
    this.opts = opts;
    if (opts.persistKey) {
      try {
        const raw = localStorage.getItem(opts.persistKey);
        if (raw) {
          const saved = JSON.parse(raw) as { files: [string, string][]; dirs: string[] };
          this.files = new Map(saved.files);
          this.dirs = new Set(saved.dirs);
        }
      } catch { /* start empty */ }
    }
  }

  private save() {
    if (!this.opts.persistKey) return;
    try { localStorage.setItem(this.opts.persistKey, JSON.stringify({ files: [...this.files], dirs: [...this.dirs] })); } catch { /* ignore */ }
  }
  private notify(path: string) {
    for (const w of this.watchers) if (path === w.dir || path.startsWith(w.dir + '/')) w.cb();
  }
  private guard(path: string) {
    if (this.opts.readOnly?.some(d => path === d || path.startsWith(d + '/'))) throw new Error(`Permission denied: ${path}`);
  }
  private ensureParents(path: string) {
    for (let d = parentOf(path); !this.dirs.has(d); d = parentOf(d)) this.dirs.add(d);
  }

  async read(path: string) { return checkSize(path, this.files.get(path) ?? null); }
  async write(path: string, text: string) {
    this.guard(path);
    if (!this.dirs.has(parentOf(path))) throw new Error(`No such folder: ${parentOf(path)}`);
    this.files.set(path, text); this.save(); this.notify(path);
  }
  async list(dir: string) {
    const out = new Map<string, boolean>();
    const prefix = dir.replace(/\/$/, '') + '/';
    for (const f of this.files.keys()) if (f.startsWith(prefix)) { const rest = f.slice(prefix.length); const i = rest.indexOf('/'); out.set(i < 0 ? rest : rest.slice(0, i), i >= 0); }
    for (const d of this.dirs) if (d.startsWith(prefix) && d !== prefix) { const rest = d.slice(prefix.length); const i = rest.indexOf('/'); out.set(i < 0 ? rest : rest.slice(0, i), true); }
    return [...out].sort(([a], [b]) => a.localeCompare(b)).map(([name, isDir]) => ({ name, isDir }));
  }
  async mkdir(dir: string) {
    this.guard(dir);
    const d = dir.replace(/\/$/, '');
    this.ensureParents(d + '/x'); this.dirs.add(d); this.save();
  }
  async rename(from: string, to: string) {
    this.guard(to);
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`No such file: ${from}`);
    this.files.delete(from); this.files.set(to, v); this.save(); this.notify(to);
  }
  async remove(path: string) {
    this.guard(path);
    this.files.delete(path); this.dirs.delete(path);
    for (const f of [...this.files.keys()]) if (f.startsWith(path + '/')) this.files.delete(f);
    for (const d of [...this.dirs]) if (d.startsWith(path + '/')) this.dirs.delete(d);
    this.save(); this.notify(path);
  }
  async exists(path: string) { return this.files.has(path) || this.dirs.has(path.replace(/\/$/, '')); }
  async watch(dir: string, cb: () => void) {
    const w = { dir: dir.replace(/\/$/, ''), cb };
    this.watchers.add(w);
    return () => { this.watchers.delete(w); };
  }

  /** Tests: change a file behind the app's back without telling watchers (like a `git pull` with no watcher). */
  poke(path: string, text: string | null) {
    if (text === null) this.files.delete(path);
    else { this.ensureParents(path); this.files.set(path, text); }
    this.save();
  }
}

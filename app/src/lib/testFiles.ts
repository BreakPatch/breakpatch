// Files a test uploads: the bundled samples, and the user's own in <tests folder>/files (next to
// apps/), so a test and the file it uploads travel together. Used when a click on the page opens
// its file picker (engine event `record.fileChooser`), and by runs (`filesDir`).
import type { SampleFile } from '../data/types';
import { SAMPLES } from '../engine/labels';
import { isTauri } from '../platform';
import { baseName, join, tempName } from '../data/local/storage';

export const FILES_DIR = 'files';

/** <tests folder>/files, or undefined without a tests folder (Team keeps tests in the cloud). */
export function filesDir(testsFolder: string | undefined): string | undefined {
  return testsFolder ? join(testsFolder, FILES_DIR) : undefined;
}

/** What each sample matches in an `accept` attribute: MIME types and extensions. */
const SAMPLE_TYPES: Record<SampleFile, string[]> = {
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/msword', '.docx', '.doc'],
  pdf: ['application/pdf', '.pdf'],
  jpeg: ['image/jpeg', 'image/jpg', 'image/*', '.jpg', '.jpeg'],
  mp4: ['video/mp4', 'video/*', '.mp4'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-excel', '.xlsx', '.xls'],
  csv: ['text/csv', '.csv', 'text/*'],
};

/** Whether a sample (or a file name) fits the input's `accept` ("" accepts anything). */
export function accepts(accept: string, what: SampleFile | string): boolean {
  const want = accept.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
  if (!want.length) return true;
  if (what in SAMPLE_TYPES) return SAMPLE_TYPES[what as SampleFile].some(t => want.includes(t));
  const ext = '.' + (what.toLowerCase().split('.').pop() ?? '');
  return want.includes(ext) || Object.values(SAMPLE_TYPES).some(types => types.includes(ext) && types.some(t => want.includes(t)));
}

/** The six samples, the ones the input accepts first. */
export function samplesFor(accept: string): { kind: SampleFile; name: string; fits: boolean }[] {
  const all = (Object.keys(SAMPLES) as SampleFile[]).map(kind => ({ kind, name: SAMPLES[kind], fits: accepts(accept, kind) }));
  return [...all.filter(s => s.fits), ...all.filter(s => !s.fits)];
}

/** The desktop's file access for the files folder; swapped in tests. */
export interface FilesFs {
  list(dir: string): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  copy(from: string, to: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Asks for a file on this Mac (the dialog adds it to the fs scope). */
  pick(accept: string): Promise<string | null>;
}

const tauriFs: FilesFs = {
  async list(dir) {
    const fs = await import('@tauri-apps/plugin-fs');
    if (!(await fs.exists(dir))) return [];
    return (await fs.readDir(dir)).filter(e => e.isFile && !e.name.startsWith('.') && !/\.bp-[a-z0-9]+\.tmp$/.test(e.name)).map(e => e.name).sort();
  },
  async mkdir(dir) { await (await import('@tauri-apps/plugin-fs')).mkdir(dir, { recursive: true }); },
  async exists(path) { return (await import('@tauri-apps/plugin-fs')).exists(path); },
  async copy(from, to) { await (await import('@tauri-apps/plugin-fs')).copyFile(from, to); },
  async rename(from, to) { await (await import('@tauri-apps/plugin-fs')).rename(from, to); },
  async pick(accept) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const exts = accept.split(',').map(a => a.trim()).filter(a => a.startsWith('.')).map(a => a.slice(1));
    const got = await open({ multiple: false, title: 'Choose the file to upload', ...(exts.length ? { filters: [{ name: 'Files', extensions: exts }] } : {}) });
    return typeof got === 'string' ? got : null;
  },
};
const noFs: FilesFs = { async list() { return []; }, async mkdir() {}, async exists() { return false; }, async copy() {}, async rename() {}, async pick() { return null; } };

let current: FilesFs | null = null;
export function filesFs(): FilesFs { return current ?? (isTauri() ? tauriFs : noFs); }
export function setFilesFs(f: FilesFs | null) { current = f; }

/** The user's own files in the files folder, by name. */
export async function ownFiles(dir: string | undefined): Promise<string[]> {
  if (!dir) return [];
  try { return await filesFs().list(dir); } catch { return []; }
}

/**
 * Copies a file from this Mac into the files folder (a temporary name first, then renamed, so a
 * half-copied file is never used) and returns its step reference and full path. A name that's
 * taken gets " 2", " 3"… before the extension.
 */
export async function addOwnFile(dir: string, source: string): Promise<{ file: string; path: string }> {
  const f = filesFs();
  await f.mkdir(dir);
  const name = baseName(source).replace(/^\.+/, '') || 'file';
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let final = name;
  for (let n = 2; await f.exists(join(dir, final)); n++) final = `${stem} ${n}${ext}`;
  const tmp = join(dir, tempName(final));
  await f.copy(source, tmp);
  await f.rename(tmp, join(dir, final));
  return { file: `${FILES_DIR}/${final}`, path: join(dir, final) };
}

// Choosing a tests folder: what's in it, setting it up, and opening it.
import type { Person } from '../types';
import { FORMAT, SCHEMA_VERSION, fromFileText, isFolderId, newFolderId, toFileText } from './format';
import { FolderError, LocalBackend, parseMeta, readMeta, type AddressStore, type FolderSnapshot } from './localBackend';
import { baseName, isTempName, join, MemoryStorage, tempName, type FolderStorage } from './storage';

/**
 * - `breakpatch`: has a breakpatch.json this app can open.
 * - `empty`: nothing in it (hidden files like .DS_Store and our leftover temp files don't count); set it up without asking.
 * - `other`: has other files but no breakpatch.json; ask before adding ours.
 */
export type FolderKind = 'breakpatch' | 'empty' | 'other';

/** Throws a FolderError for a breakpatch.json this app can't open (newer, broken, not ours). */
export async function inspectFolder(st: FolderStorage, path: string): Promise<FolderKind> {
  if (!(await st.exists(path))) throw new FolderError('missing', "This folder isn't there any more. It may have been moved or deleted.");
  const meta = await readMeta(st, path);
  if (meta !== null) { parseMeta(meta); return 'breakpatch'; }
  const entries = (await st.list(path)).filter(e => !e.name.startsWith('.') && !isTempName(e.name));
  return entries.length ? 'other' : 'empty';
}

/** Adds breakpatch.json (with the folder's own id, format.ts newFolderId) and the apps folder. Throws FolderError('notWritable') when it can't write there. */
export async function initFolder(st: FolderStorage, path: string): Promise<void> {
  const file = join(path, 'breakpatch.json');
  try {
    await st.mkdir(join(path, 'apps'));
    const tmp = join(path, tempName('breakpatch.json'));
    await st.write(tmp, toFileText({ format: FORMAT, schemaVersion: SCHEMA_VERSION, id: newFolderId(), name: baseName(path) }));
    await st.rename(tmp, file);
  } catch {
    throw new FolderError('notWritable', "Breakpatch can't save files in this folder. Choose a folder you can write to.");
  }
}

/** Checks the folder can be written before opening it (a read-only mount, missing permissions). */
export async function checkWritable(st: FolderStorage, path: string): Promise<void> {
  const probe = join(path, tempName('breakpatch-write-check'));
  try { await st.write(probe, ''); await st.remove(probe); }
  catch { throw new FolderError('notWritable', "Breakpatch can't save files in this folder. Choose a folder you can write to."); }
}

// ---- storage for this build ----

const PREVIEW_KEY = 'breakpatch.previewFiles.v1';
let preview: MemoryStorage | undefined;

/** Where the browser preview's "Choose a folder" points. */
export const PREVIEW_FOLDER = '/Users/you/Projects/web-app/breakpatch-tests';

/** Browser preview: memory, or localStorage with the dev flag `?keepfiles` (survives a reload). */
export function previewStorage(): MemoryStorage {
  if (!preview) {
    const keep = typeof location !== 'undefined' && new URLSearchParams(location.search).has('keepfiles');
    preview = new MemoryStorage(keep ? { persistKey: PREVIEW_KEY } : {});
    void preview.mkdir(PREVIEW_FOLDER);
  }
  return preview;
}

export async function folderStorage(): Promise<FolderStorage> {
  const { isTauri } = await import('../../platform');
  if (!isTauri()) return previewStorage();
  const { TauriStorage } = await import('./tauriStorage');
  return new TauriStorage();
}

// ---- the person ----

export const FALLBACK_NAME = 'You';

/** The one person on this Mac: their macOS full name when the shell can give it. */
export async function localPerson(): Promise<Person> {
  const { fullUserName } = await import('../../platform');
  const name = (await fullUserName().catch(() => null))?.trim();
  return { uid: 'local', name: name || FALLBACK_NAME, email: '' };
}

/**
 * Opens a folder that has a breakpatch.json. `addresses` is the edition's result address store
 * (edition.resultAddresses: the Team edition keeps them apart from the folder; Community keeps
 * none). The caller passes it, so this data layer doesn't import the edition (and its state): the
 * back office type-checks the components that reach this file without the app's packages.
 */
export async function openLocalFolder(path: string, addresses?: AddressStore): Promise<LocalBackend> {
  const [storage, person] = await Promise.all([folderStorage(), localPerson()]);
  return LocalBackend.open({ storage, path, person, addresses });
}

/**
 * Reads a whole tests folder once without opening it in the app or changing it (e.g. to copy
 * it into a Team workspace). Throws a FolderError when it's gone or isn't a Breakpatch folder.
 */
export async function readLocalFolder(path: string): Promise<FolderSnapshot> {
  const [storage, person] = await Promise.all([folderStorage(), localPerson()]);
  if (!(await storage.exists(path))) throw new FolderError('missing', "This folder isn't there any more. It may have been moved or deleted.");
  return LocalBackend.read({ storage, path, person });
}

/**
 * A tests folder's own id (breakpatch.json `id`, format.ts newFolderId), read without opening it,
 * or null: it has none yet, or it isn't there or isn't a Breakpatch folder. One file is read.
 */
export async function readFolderId(path: string, st?: FolderStorage): Promise<string | null> {
  try {
    const text = await readMeta(st ?? await folderStorage(), path.replace(/\/+$/, '') || '/');
    // Not parseMeta: a folder saved by a newer app still names itself.
    const v = text === null ? null : fromFileText<Record<string, unknown> | null>(text);
    return v && typeof v === 'object' && v.format === FORMAT && isFolderId(v.id) ? v.id : null;
  } catch { return null; }
}

/** First name for greetings; '' for the "You" fallback, so nobody is greeted as "You". */
export function firstNameOf(p: Person | null | undefined): string {
  if (!p || (p.uid === 'local' && p.name === FALLBACK_NAME)) return '';
  return p.name.split(/\s+/)[0] ?? '';
}

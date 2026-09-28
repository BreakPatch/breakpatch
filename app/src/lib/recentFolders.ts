// The last 5 tests folders opened on this Mac (Welcome → "Open a recent folder").
const KEY = 'breakpatch.recentFolders.v1';
const MAX = 5;

export function recentFolders(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, MAX) : [];
  } catch { return []; }
}

function save(list: string[]) { try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX))); } catch { /* ignore */ } }

/** Moves the folder to the front. */
export function addRecentFolder(path: string) { save([path, ...recentFolders().filter(p => p !== path)]); }

export function forgetRecentFolder(path: string) { save(recentFolders().filter(p => p !== path)); }

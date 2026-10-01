// Thin layer over things only the desktop shell can do. Each call falls back to
// browser behaviour so the UI also runs in a plain browser (demo and tests).
import type { SecretInfo, SecretPolicy } from './data/types';

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall through */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
}

/**
 * The clipboard's text, for a Paste button; null when it can't be read. In the app it's read
 * through the shell (tauri-plugin-clipboard-manager): WebKit's navigator.clipboard.readText()
 * first shows a "Paste" bubble to confirm. In a browser (the preview), navigator.clipboard.
 */
export async function readClipboard(): Promise<string | null> {
  if (isTauri()) {
    try { return await tauriInvoke<string>('plugin:clipboard-manager|read_text'); }
    catch { /* an older shell without the plugin: the browser's way */ }
  }
  try { return await navigator.clipboard.readText(); } catch { return null; }
}

/** Saves text to a file the user picks (desktop) or downloads it (browser). */
export async function saveTextFile(defaultName: string, contents: string): Promise<boolean> {
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({ defaultPath: defaultName });
    if (!path) return false;
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(path, contents);
    return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  a.download = defaultName; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  return true;
}

/** Lets the user pick a file and returns its text (e.g. a .bpworkspace file). */
export async function openTextFile(extensions: string[]): Promise<string | null> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({ multiple: false, filters: [{ name: 'Workspace', extensions }] });
    if (!path || Array.isArray(path)) return null;
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    return readTextFile(path);
  }
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = extensions.map(e => '.' + e).join(',');
    input.onchange = () => { const f = input.files?.[0]; if (!f) return resolve(null); f.text().then(resolve, () => resolve(null)); };
    input.click();
  });
}

// ---- Saved secrets: macOS Keychain on desktop, memory in the browser ----
// Each secret has the sites it may be typed on and a "Runner can use" flag, kept by the shell next
// to its name (never the value). The shell hands them to the engine with every run, so a test file
// can't type a secret anywhere else (engine/PROTOCOL.md "Saved secrets").
const memSecrets = new Map<string, string>([['ACME_TEST_EMAIL', 'qa@acme.example'], ['ACME_TEST_PASSWORD', 'demo-password']]);
const memPolicies = new Map<string, Omit<SecretPolicy, 'name'>>([
  ['ACME_TEST_EMAIL', { origins: ['https://app.example.com'], runnerCanUse: false }],
  ['ACME_TEST_PASSWORD', { origins: ['https://app.example.com'], runnerCanUse: false }],
]);

export interface SetSecretOptions { origins?: string[]; runnerCanUse?: boolean }

export const secrets = {
  async list(): Promise<string[]> {
    if (isTauri()) return tauriInvoke<string[]>('secrets_list');
    return [...memSecrets.keys()];
  },
  /** Names with their sites and "Runner can use" flag. The Team runner reads the flag here. */
  async info(): Promise<SecretPolicy[]> {
    if (isTauri()) return tauriInvoke<SecretPolicy[]>('secrets_info');
    return [...memSecrets.keys()].sort().map(name => ({ name, origins: [], runnerCanUse: false, ...memPolicies.get(name) }));
  },
  /** Saves a value. `origins` / `runnerCanUse` set where it may be used; left out, they stay as they were. */
  async set(name: string, value: string, opts: SetSecretOptions = {}): Promise<void> {
    if (isTauri()) return tauriInvoke('secrets_set', { name, value, origins: opts.origins ?? null, runnerCanUse: opts.runnerCanUse ?? null });
    memSecrets.set(name, value);
    const before = memPolicies.get(name) ?? { origins: [], runnerCanUse: false };
    memPolicies.set(name, { origins: opts.origins ?? before.origins, runnerCanUse: opts.runnerCanUse ?? before.runnerCanUse });
  },
  /** Changes where a saved secret may be used, without its value. */
  async setPolicy(name: string, origins: string[], runnerCanUse: boolean): Promise<void> {
    if (isTauri()) return tauriInvoke('secrets_set_policy', { name, origins, runnerCanUse });
    if (!memSecrets.has(name)) throw new Error(`There's no saved secret ${name} on this Mac.`);
    memPolicies.set(name, { origins: [...new Set(origins)], runnerCanUse });
  },
  async remove(name: string): Promise<void> {
    if (isTauri()) return tauriInvoke('secrets_delete', { name });
    memSecrets.delete(name); memPolicies.delete(name);
  },
  /** Values for a run. Only the engine ever sees them; the UI never shows a value. */
  async resolve(names: string[]): Promise<Record<string, string>> {
    if (isTauri()) return tauriInvoke<Record<string, string>>('secrets_resolve', { names });
    return Object.fromEntries(names.filter(n => memSecrets.has(n)).map(n => [n, memSecrets.get(n)!]));
  },
};

export type { SecretInfo, SecretPolicy };

// ---- Result addresses of suites in a tests folder: macOS Keychain on desktop, memory in the browser ----
// Where a folder suite's result message goes (Solo, the Team edition). Anyone with the address can
// post to it, so it stays out of the folder, which may be shared through Git (src-tauri results.rs).
const memAddresses = new Map<string, string>();

export const resultAddresses = {
  /** The address saved for this suite of this connection (`local:<hash>`), or null. */
  async get(wsKey: string, suiteId: string): Promise<string | null> {
    if (isTauri()) return (await tauriInvoke<string | null>('result_address_get', { wsKey, suiteId })) ?? null;
    return memAddresses.get(`${wsKey}/${suiteId}`) ?? null;
  },
  /** Saves it (null: forgets it). */
  async set(wsKey: string, suiteId: string, url: string | null): Promise<void> {
    if (isTauri()) return tauriInvoke('result_address_set', { wsKey, suiteId, url });
    if (url) memAddresses.set(`${wsKey}/${suiteId}`, url); else memAddresses.delete(`${wsKey}/${suiteId}`);
  },
};

/** Listens for breakpatch://connect#c=… links and opened .bpworkspace files. */
export async function onWorkspaceLink(cb: (payload: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
  const first = await getCurrent().catch(() => null);
  first?.forEach(cb);
  const { listen } = await import('@tauri-apps/api/event');
  const offFile = await listen<string>('workspace-file', e => cb(e.payload));
  const offUrl = await onOpenUrl(urls => urls.forEach(cb));
  // A file opened at launch arrives before this listener exists; the shell keeps it for us.
  const launchFile = await tauriInvoke<string | null>('workspace_file_take').catch(() => null);
  if (launchFile) cb(launchFile);
  return () => { offFile(); offUrl(); };
}

export function appVersion(): string { return import.meta.env.VITE_APP_VERSION ?? '0.1.0'; }

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) { const { open } = await import('@tauri-apps/plugin-shell'); await open(url); return; }
  window.open(url, '_blank', 'noopener');
}

// ---- Tests folder (Community) ----

/** Asks for a folder. The dialog adds it (recursively) to the fs scope; persisted-scope keeps it across restarts. */
export async function pickFolder(title = 'Choose a folder for your tests'): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const path = await open({ directory: true, multiple: false, recursive: true, title });
  return typeof path === 'string' ? path : null;
}

/** Shows the folder in Finder. */
export async function revealInFinder(path: string): Promise<void> {
  if (isTauri()) await tauriInvoke('reveal_in_finder', { path });
}

/** The macOS full name ("Maria Lopez"), or null when the shell can't give it. */
export async function fullUserName(): Promise<string | null> {
  if (!isTauri()) return null;
  return tauriInvoke<string | null>('system_full_name');
}

// ---- Upgrade to Team: moving the copied tests folder to the Trash (src-tauri migration.rs) ----

/** What a Trash request did. `error`: why it stopped part-way (what's in `moved` went before it). */
export interface TrashResult { moved: string[]; missing: string[]; error?: string }

/**
 * Moves items to the Trash (to undo it, drag them back out of the Trash: Finder may not offer Put
 * Back for them). The shell only accepts breakpatch.json, apps and suites directly under a tests
 * folder opened in Breakpatch with a valid breakpatch.json, or run folders directly under the
 * screenshots folder; anything else is refused before anything moves. A folder that isn't there
 * any more, or whose breakpatch.json went already, has every name missing.
 * Browser preview: removes them from the in-memory folder instead.
 */
export async function trashItems(place: 'folder' | 'screenshots', folder: string | null, names: string[]): Promise<TrashResult> {
  if (isTauri()) return tauriInvoke<TrashResult>('trash_items', { place, folder, names });
  if (place === 'screenshots') return { moved: [], missing: names };
  const { previewStorage } = await import('./data/local/folder');
  const st = previewStorage();
  const out: TrashResult = { moved: [], missing: [] };
  const wanted = ['apps', 'suites', 'breakpatch.json'].filter(x => names.includes(x));
  // As the shell does (migration.rs `plan`): without breakpatch.json, only a finished move is asked about again.
  if (!(await st.exists(`${folder}/breakpatch.json`))) {
    for (const n of wanted) if (await st.exists(`${folder}/${n}`)) throw new Error("This isn't a Breakpatch tests folder (its breakpatch.json is missing or not valid).");
    return { moved: [], missing: wanted };
  }
  for (const n of wanted) {
    const p = `${folder}/${n}`;
    if (await st.exists(p)) { await st.remove(p); out.moved.push(n); } else out.missing.push(n);
  }
  return out;
}

/** This Mac's screenshots folder (the engine's), or null in a browser preview. */
export async function screenshotsFolder(): Promise<string | null> {
  if (!isTauri()) return null;
  return tauriInvoke<string>('screenshots_folder');
}

/** The Git repository holding this folder, or null. The shell only looks for `.git`; it never runs git. */
export async function gitRepoOf(path: string): Promise<string | null> {
  if (!isTauri()) return null;
  return tauriInvoke<string | null>('git_repo_of', { path });
}

/** Keeps a report in the app's data folder and returns where (null in a browser preview). */
export async function saveMigrationReport(text: string): Promise<string | null> {
  if (!isTauri()) return null;
  return tauriInvoke<string>('migration_report_save', { text });
}

// App-wide session: which workspace (Team, or the demo) or tests folder (Community) this Mac
// uses, the backend for it, the person, setup progress and appearance. Persisted per Mac.
//
// What can be opened is the connection list (connections.ts, `breakpatch.connections.v1`); this
// keeps the active one. `breakpatch.session.v1` is still written for the active connection for
// one release, so an older app opens the same workspace or folder after a downgrade.
import { create } from 'zustand';
import type { Backend } from '../data/backend';
import type { Person, Workspace } from '../data/types';
import { DemoBackend, DEMO_WORKSPACE } from '../data/demo/demoBackend';
import { edition } from '../edition';
import { openLocalFolder } from '../data/local/folder';
import { countUsage } from '../data/countUsage';
import { addRecentFolder } from '../lib/recentFolders';
import { useSystem } from './system';
import { connections, folderConnection, useConnections, workspaceConnection, type Connection } from './connections';

export type Theme = 'dark' | 'light' | 'system';
export type SetupTask = 'browser' | 'mac' | 'model';
export type TaskState = 'waiting' | 'busy' | 'paused' | 'done' | 'failed';

export interface Prefs {
  theme: Theme;
  autoFix: boolean;              // "Fix moved buttons automatically"
  failOnFix: boolean;            // "Fail the test if anything needed fixing"
  allowSystemDifferences: boolean; // "Allow for small differences between systems" (Settings → Screen checks)
  runnerMode: boolean;           // "Use this Mac as the local runner"
  runnerName: string;
  /** Apps (by id) whose passwords typed as plain text shouldn't prompt "Save it as a saved secret?". */
  noSecretAsk?: string[];
  /** Settings → Notifications: a run that fails, and every finished run (lib/notify.ts). */
  notifyFailures?: boolean;
  notifyAll?: boolean;
}

/** A tests folder on this Mac (Community). */
export interface LocalFolder { path: string }

interface SessionState {
  workspace: Workspace | null;
  /** The tests folder, when this Mac uses one instead of a workspace. Never both. */
  local: LocalFolder | null;
  /** Why the saved tests folder didn't open on launch (moved, deleted, newer format). Welcome shows it. */
  localError: string | null;
  backend: Backend | null;
  user: Person | null;
  setupDone: boolean;
  prefs: Prefs;
  online: boolean;
  /** A workspace offered by a link or file, waiting for the user to confirm. */
  pendingWorkspace: Workspace | null;

  connect(ws: Workspace, o?: { remember?: boolean }): Promise<void>;
  /** Opens a tests folder that has a breakpatch.json (data/local/folder.ts sets one up). */
  connectLocal(path: string): Promise<void>;
  /** Signs out, closes and forgets the open workspace or folder (the connection list loses it). */
  disconnect(): void;
  /**
   * Switch workspace on the sign-in screen: leaves the open workspace without forgetting it, and
   * opens this Mac's tests folder when the list has one (as switchTo, without signing out).
   * `folder`: it opened; `none`: nothing is open (the app shows Welcome), the person is signed out,
   * and the folder's problem is in `localError` if it couldn't open.
   */
  leaveWorkspace(): Promise<'folder' | 'none'>;
  /**
   * Opens another connection from the list. The one open closes without signing out, so
   * switching back finds the person still signed in. The caller stops runs and goes home first.
   */
  switchTo(c: Connection): Promise<void>;
  setUser(u: Person | null): void;
  setSetupDone(v: boolean): void;
  setPrefs(p: Partial<Prefs>): void;
  setOnline(v: boolean): void;
  offerWorkspace(ws: Workspace | null): void;
}

const KEY = 'breakpatch.session.v1';
interface Saved { workspace: Workspace | null; local?: LocalFolder | null; setupDone: boolean; prefs: Prefs }
const DEFAULT_PREFS: Prefs = { theme: 'dark', autoFix: true, failOnFix: false, allowSystemDifferences: true, runnerMode: false, runnerName: 'QA Mac mini' };

function load(): Saved {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) { const s = JSON.parse(raw) as Saved; return { ...s, prefs: { ...DEFAULT_PREFS, ...s.prefs } }; }
  } catch { /* first launch or storage unavailable */ }
  return { workspace: null, local: null, setupDone: false, prefs: DEFAULT_PREFS };
}
function save(s: Saved) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } }

/** Demo mode: `?demo` in the address (browser preview) or a workspace named with the demo project id. */
export function isDemoWorkspace(ws: Workspace) { return ws.config.apiKey === 'demo'; }

export async function makeBackend(ws: Workspace): Promise<Backend> {
  if (isDemoWorkspace(ws)) {
    const q = new URLSearchParams(location.search);
    // `?delay=ms` slows the first read, to see loading skeletons and "Still loading".
    const delayMs = q.has('delay') ? Number(q.get('delay')) || 10_000 : undefined;
    // Community has no sign-in (one person, one Mac), so its demo is always signed in.
    const signedIn = q.has('signedin') || edition.name === 'community';
    return new DemoBackend({ empty: q.has('empty'), signedIn, delayMs }, ws);
  }
  if (!edition.openWorkspace) throw new Error('This edition of Breakpatch opens tests from a folder on this Mac, not a team workspace.');
  return edition.openWorkspace(ws);
}

/**
 * Whether this edition opens the saved workspace on launch. Community has no workspaces: a
 * saved team workspace is forgotten, and the demo opens only while `?demo` is in the address.
 */
export function canOpen(ws: Workspace) {
  if (edition.openWorkspace) return true;
  return isDemoWorkspace(ws) && new URLSearchParams(location.search).has('demo');
}

let readOnlyOff: (() => void) | undefined;
let warningsOff: (() => void) | undefined;
let userOff: (() => void) | undefined;
/**
 * A backend that can't save (e.g. a newer data format in the workspace) shows the read-only
 * banner; one that skipped data (a broken file in the tests folder) shows a warning. A new
 * backend also stops the old one's person reaching the session (followUser).
 */
function watchBackend(b: Backend | null) {
  readOnlyOff?.(); readOnlyOff = undefined;
  warningsOff?.(); warningsOff = undefined;
  userOff?.(); userOff = undefined;
  useSystem.getState().setReadOnly(false);
  useSystem.getState().setWarnings([]);
  if (b?.onReadOnly) readOnlyOff = b.onReadOnly(v => useSystem.getState().setReadOnly(v));
  if (b?.onWarnings) warningsOff = b.onWarnings(v => useSystem.getState().setWarnings(v));
}

/**
 * The backend's signed-in person becomes the session's user, while it's still the open backend:
 * a closed workspace's late sign-in event never shows its person in another workspace.
 */
function followUser(b: Backend | null) {
  userOff?.(); userOff = undefined;
  if (!b) return;
  userOff = b.onUser(u => { if (useSession.getState().backend === b) useSession.getState().setUser(u); });
}

/**
 * Closes the open backend, and its read-only state and warnings stop reaching the session. With
 * `signOut` (disconnect, leaveWorkspace) the person is signed out first; not when another opens
 * (connect, connectLocal, so switchTo): switching back finds the person still signed in.
 */
function closeBackend(b: Backend | null, o: { signOut: boolean }) {
  if (o.signOut) b?.signOut().catch(() => {});
  b?.close?.();
  watchBackend(null);
}

const saved = load();

export const useSession = create<SessionState>((set, get) => ({
  workspace: saved.workspace,
  local: saved.local ?? null,
  localError: null,
  backend: null,
  user: null,
  setupDone: saved.setupDone,
  prefs: saved.prefs,
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  pendingWorkspace: null,

  async connect(ws, o = {}) {
    // Tests created and runs are counted where they're saved (data/countUsage.ts); the demo isn't.
    const backend = countUsage(await makeBackend(ws));
    closeBackend(get().backend, { signOut: false });
    if (o.remember !== false) connections.opened(workspaceConnection(ws));
    set({ workspace: ws, local: null, localError: null, backend, user: backend.currentUser(), pendingWorkspace: null });
    watchBackend(backend);
    persist();
  },
  async connectLocal(path) {
    const backend = countUsage(await openLocalFolder(path));
    closeBackend(get().backend, { signOut: false });
    connections.opened(folderConnection(backend.local.path, backend.name));
    set({ workspace: null, local: { path: backend.local.path }, localError: null, backend, user: backend.currentUser(), pendingWorkspace: null });
    watchBackend(backend);
    addRecentFolder(backend.local.path);
    persist();
  },
  disconnect() {
    closeBackend(get().backend, { signOut: true });
    const { activeId } = useConnections.getState();
    if (activeId) connections.remove(activeId);
    set({ workspace: null, local: null, backend: null, user: null, setupDone: false });
    persist();
  },
  async leaveWorkspace() {
    const folder = useConnections.getState().list.find(c => c.kind === 'local' && c.local);
    if (folder) {
      try { await get().switchTo(folder); return 'folder'; }
      catch (e) { set({ localError: `${folder.local!.path}: ${e instanceof Error ? e.message : String(e)}` }); }
    }
    closeBackend(get().backend, { signOut: true });
    connections.deactivate();
    set({ workspace: null, local: null, backend: null, user: null, pendingWorkspace: null });
    persist();
    return 'none';
  },
  async switchTo(c) {
    if (c.kind === 'local' && c.local) await get().connectLocal(c.local.path);
    else if ((c.kind === 'team' || c.kind === 'demo' || (c.kind === 'hosted' && c.team?.workspace.tenant)) && c.team) {
      await get().connect(c.team.workspace);
      // The saved sign-in comes back with the backend (bootSession does the same on launch).
      followUser(get().backend);
    } else throw new Error("This version of Breakpatch can't open this kind of workspace. Update Breakpatch to open it.");
  },
  setUser(user) { set({ user }); },
  setSetupDone(setupDone) { set({ setupDone }); persist(); },
  setPrefs(p) { set({ prefs: { ...get().prefs, ...p } }); persist(); },
  setOnline(online) { set({ online }); },
  offerWorkspace(pendingWorkspace) { set({ pendingWorkspace }); },
}));

function persist() {
  const s = useSession.getState();
  save({ workspace: s.workspace, local: s.local, setupDone: s.setupDone, prefs: s.prefs });
}

/**
 * Restores the saved workspace or tests folder on launch. `?demo` connects the sample
 * workspace (for this launch; a saved tests folder stays saved).
 */
export async function bootSession() {
  const q = new URLSearchParams(location.search);
  const s = useSession.getState();
  // A workspace this edition can't open (a team workspace, or the demo without ?demo, in Community) stays closed.
  if (s.workspace && !canOpen(s.workspace)) useSession.setState({ workspace: null });
  const saved = useSession.getState().workspace;
  const local = useSession.getState().local;
  if (q.has('demo') && (!saved || isDemoWorkspace(saved))) await connectDemo();
  else if (saved) await s.connect(saved);
  else if (local) {
    try { await s.connectLocal(local.path); }
    catch (e) {
      // Moved, deleted or saved by a newer app: back to Welcome, which says why. The browser
      // preview's in-memory folder is simply gone after a reload, so it says nothing.
      const { isTauri } = await import('../platform');
      useSession.setState({ local: null, localError: isTauri() ? `${local.path}: ${(e as Error).message}` : null });
      persist();
    }
  }
  if (q.has('demo') && q.has('ready')) s.setSetupDone(true);
  const theme = q.get('theme');
  if (theme === 'dark' || theme === 'light' || theme === 'system') s.setPrefs({ theme });
  followUser(useSession.getState().backend);
}

/** `?demo` over a saved tests folder: open the demo for this launch and keep the folder saved. */
async function connectDemo() {
  const local = useSession.getState().local;
  await useSession.getState().connect(DEMO_WORKSPACE, { remember: false });
  if (local) { const st = useSession.getState(); save({ workspace: st.workspace, local, setupDone: st.setupDone, prefs: st.prefs }); }
}

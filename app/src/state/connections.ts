// What this Mac can open, like Slack's workspaces: the personal space (a tests folder on this Mac)
// and any number of Team workspaces, plus the demo. One is active at a time; the switcher in the
// title bar (components/shell/WorkspaceSwitcher.tsx) moves between them.
//
// Stored as `breakpatch.connections.v1` (the list and the active id). On the first launch of a
// version that has it, the list is built from `breakpatch.session.v1`, which session.ts still
// writes for the active connection (for one release), so an older app opens the same thing.
//
// A connection's id is also its key for what belongs to it on this Mac: the licence in the
// Keychain (`licence:<id>`, src-tauri licence.rs) and its usage counts (usage.rs). Ids are made
// from what they point at, so connecting the same workspace or folder again finds the same one
// (connectionIds.ts, a persisted contract with a test that pins it):
//   team:<projectId>/<database>   a Team workspace
//   local:<hash of the path>      a tests folder (it may hold a licence too: the Solo plan)
//   demo                          the demo workspace
//   hosted:<workspaceId>          reserved: a workspace in Breakpatch Cloud (breakpatch-team #28),
//                                 many in one project, so its key names the workspace, never the
//                                 project. Not built yet: kept in the list, never opened here.
// Nothing keyed by a connection (licence, usage, the move's journal) assumes one workspace per
// Firebase project: they all use this id.
import { create } from 'zustand';
import type { Workspace } from '../data/types';
import { folderConnectionId, isDemoConnection as isDemo, workspaceConnectionId } from './connectionIds';

export { folderConnectionId, workspaceConnectionId };

/** `hosted` is reserved for Breakpatch Cloud; this version keeps such entries but can't open them. */
export type ConnectionKind = 'local' | 'team' | 'demo' | 'hosted';

export interface Connection {
  id: string;
  kind: ConnectionKind;
  /** The workspace's name, or the tests folder's. */
  name: string;
  /** The personal space: a tests folder on this Mac. */
  personal?: boolean;
  local?: { path: string };
  team?: { workspace: Workspace };
  lastOpenedAt: number;
}

interface Saved { list: Connection[]; activeId: string | null }

export const CONNECTIONS_KEY = 'breakpatch.connections.v1';
const SESSION_KEY = 'breakpatch.session.v1';

export function workspaceConnection(ws: Workspace, now = Date.now()): Connection {
  return { id: workspaceConnectionId(ws), kind: isDemo(ws) ? 'demo' : 'team', name: ws.name, team: { workspace: ws }, lastOpenedAt: now };
}
export function folderConnection(path: string, name?: string, now = Date.now()): Connection {
  const p = path.replace(/\/+$/, '') || '/';
  return { id: folderConnectionId(p), kind: 'local', name: name || p.slice(p.lastIndexOf('/') + 1) || p, personal: true, local: { path: p }, lastOpenedAt: now };
}

function valid(c: unknown): c is Connection {
  const v = c as Partial<Connection> | null;
  if (!v || typeof v !== 'object' || typeof v.id !== 'string' || typeof v.name !== 'string') return false;
  if (v.kind === 'local') return typeof v.local?.path === 'string';
  if (v.kind === 'team' || v.kind === 'demo') return !!v.team?.workspace?.config;
  // A kind a newer version made (hosted, or one not thought of yet): kept, so going back and
  // forth between versions never loses it, and never opened here.
  return typeof v.kind === 'string';
}

/** The connection session.v1 describes (the active one written by this app or an older one). */
function fromSession(): Connection | null {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) ?? 'null') as { workspace?: Workspace | null; local?: { path: string } | null } | null;
    if (s?.workspace?.config) return workspaceConnection(s.workspace, 0);
    if (typeof s?.local?.path === 'string') return folderConnection(s.local.path, undefined, 0);
  } catch { /* nothing saved */ }
  return null;
}

/**
 * The list, built from session.v1 on first launch. When session.v1 names something the list
 * doesn't have active (an older app wrote it after a downgrade), that becomes active.
 */
export function loadConnections(): Saved {
  let saved: Saved | null = null;
  try {
    const v = JSON.parse(localStorage.getItem(CONNECTIONS_KEY) ?? 'null') as Partial<Saved> | null;
    if (v && Array.isArray(v.list)) {
      const list = v.list.filter(valid);
      saved = { list, activeId: typeof v.activeId === 'string' && list.some(c => c.id === v.activeId) ? v.activeId : null };
    }
  } catch { /* first launch or storage unavailable */ }
  const now = fromSession();
  if (!saved) {
    saved = { list: now ? [now] : [], activeId: now?.id ?? null };
    store(saved);
    return saved;
  }
  if (now && saved.activeId !== now.id) {
    const had = saved.list.find(c => c.id === now.id);
    saved = { list: had ? saved.list : [...saved.list, now], activeId: now.id };
    store(saved);
  }
  return saved;
}

function store(s: Saved) { try { localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(s)); } catch { /* ignore */ } }

export const useConnections = create<Saved>(() => loadConnections());

function set(s: Saved) { useConnections.setState(s); store(s); }

export const connections = {
  /** Adds or updates the connection and makes it the active one. */
  opened(c: Connection) {
    const { list } = useConnections.getState();
    const before = list.find(x => x.id === c.id);
    const next = { ...before, ...c, lastOpenedAt: Date.now() };
    set({ list: before ? list.map(x => (x.id === c.id ? next : x)) : [...list, next], activeId: c.id });
  },
  /** Forgets a connection. Its data on this Mac (a licence, a tests folder) isn't touched here. */
  remove(id: string) {
    const { list, activeId } = useConnections.getState();
    set({ list: list.filter(c => c.id !== id), activeId: activeId === id ? null : activeId });
  },
  /** Nothing is open now; the list stays as it is (leaving a workspace without forgetting it). */
  deactivate() { const { list } = useConnections.getState(); set({ list, activeId: null }); },
  /** For tests only: read again from storage. */
  reloadForTests() { useConnections.setState(loadConnections()); },
};

export function activeConnection(): Connection | null {
  const { list, activeId } = useConnections.getState();
  return list.find(c => c.id === activeId) ?? null;
}

/** Whether this version can open it (a tests folder, a Team workspace, the demo). */
export function canOpenKind(c: Connection): boolean {
  return (c.kind === 'local' && !!c.local) || ((c.kind === 'team' || c.kind === 'demo') && !!c.team);
}

/** Personal first, then workspaces by name; the demo last. */
export function sortedConnections(list: Connection[]): Connection[] {
  const rank = (c: Connection) => (c.personal ? 0 : c.kind === 'demo' ? 2 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

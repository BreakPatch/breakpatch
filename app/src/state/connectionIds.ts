// A connection's id (connections.ts), kept on its own because it's a persisted contract across
// both repos: it names the licence in the Keychain (`licence:<id>`, src-tauri licence.rs, whose
// `valid_ws_key` must accept every id made here), the usage counts (usage.rs), the move's journal
// (the Team module's upgrade/journal.ts) and the connection list. connectionIds.test.ts pins the
// format; changing it orphans all of those, so it needs a migration, not an edit.
//   team:<projectId>/<database>   a Team workspace
//   local:<hash of the path>      a tests folder
//   demo                          the demo workspace
import type { Workspace } from '../data/types';

/** FNV-1a, 32 bits, twice: a short stable id for a path. Not for secrets. */
function pathHash(s: string): string {
  const run = (h: number) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h >>> 0; };
  return run(0x811c9dc5).toString(16).padStart(8, '0') + run(0x050c5d1f).toString(16).padStart(8, '0');
}

export function isDemoConnection(ws: Workspace) { return ws.config.apiKey === 'demo'; }

export function workspaceConnectionId(ws: Workspace): string {
  return isDemoConnection(ws) ? 'demo' : `team:${ws.config.projectId}/${ws.database}`;
}

/** A trailing slash doesn't make it another folder. */
export function folderConnectionId(path: string): string { return `local:${pathHash(path.replace(/\/+$/, ''))}`; }

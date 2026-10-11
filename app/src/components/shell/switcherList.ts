// What the title bar's workspace switcher (WorkspaceSwitcher.tsx) lists and how it opens one,
// shared with the edition's pieces beside it (Team: Manage workspaces).
import { canOpenHere, useSession } from '../../state/session';
import { sortedConnections, type Connection } from '../../state/connections';

/** The connections this edition can open, in the switcher's order (⌘1 is the first). */
export function switcherList(list: readonly Connection[]): Connection[] {
  return sortedConnections(list.filter(canOpenHere));
}

/**
 * Opens another connection the way the switcher does: home first, the recorder's browser closed,
 * then the other one (the one open closes without signing out).
 */
export async function openConnection(c: Connection, navigate: (path: string) => void): Promise<void> {
  navigate('/');
  const { getEngine } = await import('../../engine');
  await getEngine().closeBrowser().catch(() => {});
  await useSession.getState().switchTo(c);
}

export function labelOf(c: Connection): string { return c.personal ? `Personal: ${c.name}` : c.kind === 'demo' ? 'Demo workspace' : c.name; }
export function iconOf(c: Connection): string { return c.personal ? 'folder' : c.kind === 'demo' ? 'science' : c.kind === 'hosted' ? 'cloud' : 'hub'; }

/** Where a connection is: hosted, its Firebase project and database, or the tests folder's path. */
export function whereOf(c: Connection): string {
  if (c.kind === 'hosted') return 'Hosted by Breakpatch';
  const ws = c.team?.workspace;
  return ws ? `${ws.config.projectId} · ${ws.database}` : c.local?.path ?? '';
}

/** Two workspaces (not tests folders) with the same name: each says where it is. */
export function sameLabel(c: Connection, all: readonly Connection[]): boolean {
  return c.kind !== 'local' && all.some(o => o.id !== c.id && o.kind !== 'local' && labelOf(o) === labelOf(c));
}

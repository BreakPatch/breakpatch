// Links that open a test or a suite in the right workspace (public roadmap #32):
//
//   breakpatch://open?ws=<where>&path=<what>
//
// <where> names the workspace the same way on every Mac:
//   team:<projectId>/<database>   a Team workspace in the team's own Firebase (its connection id)
//   hosted:<workspaceId>          a workspace Hosted by Breakpatch (its connection id)
//   folder:<id>                   a tests folder: the id in its breakpatch.json (data/local/format.ts
//                                 newFolderId), the same in every copy of the folder, wherever it is
//   demo                          the demo workspace
// <what> is apps/<appId>/tests/<testId> or suites/<suiteId>.
//
// "Copy link" on a test's and a suite's menu makes one. Clicking it opens Breakpatch, switches to
// that workspace (as the switcher does) and opens the test in the recorder, or the suite. When the
// workspace isn't on this Mac, a plain message says so (components/shell/OpenLinks.tsx).
//
// A link is untrusted input: anyone can send one. It's read strictly (one of each part, nothing
// else in the path), every id must be a plain id (letters, digits, - _ and . but not first), and
// nothing in it ever becomes a file path: a folder is found among the folders this Mac already
// opened, by the id each one's breakpatch.json gives.
import type { Backend } from '../data/backend';
import { isFolderId } from '../data/local/format';
import { workspaceConnectionId } from '../state/connectionIds';
import type { Connection } from '../state/connections';
import type { AppError } from '../state/system';
import { osText } from './osWords';

export type LinkTarget = { kind: 'test'; appId: string; testId: string } | { kind: 'suite'; suiteId: string };
export interface OpenLink { ws: string; target: LinkTarget }

const PREFIX = 'breakpatch://open';
/** The longest link read at all. */
const MAX_LINK = 2048;
/** An app, test or suite id: what the workspaces and tests folders make, and nothing that walks a path. */
const ID = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const WS = [
  /^team:[a-z0-9][a-z0-9-]{0,62}\/(-default-|[A-Za-z][A-Za-z0-9-]{0,62})$/,
  /^hosted:[a-z0-9]{8,64}$/,
  /^demo$/,
];

/** Whether it's an open link at all (another kind of breakpatch:// link is someone else's). */
export function isOpenLink(link: string): boolean {
  const t = link.trim();
  return t === PREFIX || t.startsWith(`${PREFIX}?`) || t.startsWith(`${PREFIX}/`);
}

/** Whether `ws` names a workspace the way links do. */
export function isLinkWorkspace(ws: string): boolean {
  if (ws.startsWith('folder:')) return isFolderId(ws.slice('folder:'.length));
  return WS.some(re => re.test(ws));
}

export const isLinkId = (id: string) => ID.test(id);

/** A link's parts, or null when it isn't a whole, valid open link. */
export function parseOpenLink(link: string): OpenLink | null {
  const text = link.trim();
  if (!isOpenLink(text) || text.length > MAX_LINK) return null;
  let u: URL;
  try { u = new URL(text); } catch { return null; }
  if (u.protocol !== 'breakpatch:' || u.hostname !== 'open' || (u.pathname !== '' && u.pathname !== '/') || u.username || u.password || u.port) return null;
  const one = (k: string) => { const all = u.searchParams.getAll(k); return all.length === 1 ? all[0]! : null; };
  const ws = one('ws'), path = one('path');
  if (!ws || !path || !isLinkWorkspace(ws)) return null;
  const parts = path.split('/');
  if (parts.length === 4 && parts[0] === 'apps' && parts[2] === 'tests' && isLinkId(parts[1]!) && isLinkId(parts[3]!)) {
    return { ws, target: { kind: 'test', appId: parts[1]!, testId: parts[3]! } };
  }
  if (parts.length === 2 && parts[0] === 'suites' && isLinkId(parts[1]!)) return { ws, target: { kind: 'suite', suiteId: parts[1]! } };
  return null;
}

/** Keeps ":" and "/" readable in a link (they're fine in a query); everything else is encoded. */
const enc = (s: string) => encodeURIComponent(s).replace(/%3A/gi, ':').replace(/%2F/gi, '/');

/** The path part of a link: where the test or suite is in its workspace. */
export function linkPath(t: LinkTarget): string {
  return t.kind === 'test' ? `apps/${t.appId}/tests/${t.testId}` : `suites/${t.suiteId}`;
}

/** The link to a test or suite in the workspace `ws` names. Throws when an id can't go in a link. */
export function openLinkFor(ws: string, t: LinkTarget): string {
  const ids = t.kind === 'test' ? [t.appId, t.testId] : [t.suiteId];
  if (!isLinkWorkspace(ws) || !ids.every(isLinkId)) throw new Error(osText("This can't have a link: its name in the folder has characters a link can't carry. Rename its file, then try again."));
  return `${PREFIX}?ws=${enc(ws)}&path=${enc(linkPath(t))}`;
}

/** The app's route for a link's test (the recorder, as clicking the test does) or suite. */
export function routeOf(t: LinkTarget): string {
  return t.kind === 'test' ? `/apps/${t.appId}/tests/${t.testId}/record` : `/suites/${t.suiteId}`;
}

/**
 * How links name the open workspace: its connection id, or for a tests folder its own id (made
 * and saved in breakpatch.json the first time). Null when there's nothing to link to.
 */
export async function linkWorkspaceOf(backend: Backend | null): Promise<string | null> {
  if (!backend) return null;
  if (backend.workspace) return workspaceConnectionId(backend.workspace);
  if (backend.folderId) return `folder:${await backend.folderId()}`;
  return null;
}

/** The link to a test or suite of the open workspace or tests folder. */
export async function copyableLink(backend: Backend | null, t: LinkTarget): Promise<string> {
  const ws = await linkWorkspaceOf(backend);
  if (!ws) throw new Error("This workspace can't have links.");
  return openLinkFor(ws, t);
}

// ---------- finding the workspace on this Mac ----------

export type Resolved = { connection: Connection } | { problem: AppError };

export interface ResolveOptions {
  /** This Mac's connections and the active one (state/connections.ts). */
  list: readonly Connection[];
  activeId: string | null;
  /** Whether this edition opens it (state/session.ts canOpenHere). */
  canOpen: (c: Connection) => boolean;
  /** Whether this edition opens Team workspaces at all (Community doesn't). */
  teamEdition: boolean;
  /** A folder's own id from its breakpatch.json (data/local/folder.ts readFolderId). */
  folderIdOf: (path: string) => Promise<string | null>;
}

export const BAD_LINK: AppError = { title: "Couldn't open the link", reason: 'The link is incomplete or was changed. Ask for a new one.' };

/**
 * The connection a link's workspace is on this Mac, or the plain problem: not on this Mac (a
 * workspace this Mac isn't connected to, a tests folder it hasn't opened), or a Team workspace in
 * Community. Two copies of one tests folder: the one open now, else the one opened last.
 */
export async function resolveOpenLink(link: OpenLink, o: ResolveOptions): Promise<Resolved> {
  const open = o.list.filter(o.canOpen);
  const best = (cs: Connection[]) => cs.find(c => c.id === o.activeId) ?? [...cs].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0];
  if (link.ws.startsWith('folder:')) {
    const want = link.ws.slice('folder:'.length);
    const folders = open.filter(c => c.kind === 'local' && c.local);
    const ids = await Promise.all(folders.map(c => o.folderIdOf(c.local!.path).catch(() => null)));
    const found = best(folders.filter((_, i) => ids[i] === want));
    if (found) return { connection: found };
    return { problem: {
      title: "That tests folder isn't open on this Mac",
      reason: osText('The link is to a test in a tests folder this Mac hasn’t opened. Open the folder, or your copy of it from Git, in Breakpatch, then click the link again.'),
    } };
  }
  const found = best(open.filter(c => c.id === link.ws));
  if (found) return { connection: found };
  if (!o.teamEdition && link.ws !== 'demo') {
    return { problem: { title: 'That test is in a Team workspace', reason: osText('Breakpatch Community opens tests from a folder on this Mac. Ask whoever sent the link for a copy of the test.') } };
  }
  return { problem: {
    title: "That workspace isn't on this Mac",
    reason: osText('The link is to a test in a workspace this Mac isn’t connected to. Ask its admin for an invite, connect it, then click the link again.'),
  } };
}

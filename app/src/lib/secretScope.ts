// Which saved secrets a run, a recorded step or a tried call may use where it happens:
//
// - A secret on this Mac (the Keychain) may be kept for chosen workspaces and tests folders
//   (issue #33, Settings → Saved secrets). None chosen: every one, as for secrets saved before.
// - The open workspace may have its own secrets, saved once by an admin for everyone (Breakpatch
//   Team, issue #45: the edition's `workspaceSecrets`). A secret on this Mac allowed here wins.
//
// Requests carry this Mac's values (as before), where they happen (`workspace`, the connection id)
// and the workspace's sealed values for the names this Mac doesn't cover. The shell decides what
// the engine gets (app/src-tauri/src/secrets.rs and workspace_secrets.rs): a secret kept for other
// workspaces is refused there, whatever the UI sent, and only the shell opens a workspace's value.
import { edition } from '../edition';
import type { SecretScope } from '../engine/engine';
import { secrets, type SecretPolicy } from '../platform';
import { folderConnectionId, workspaceConnectionId } from '../state/connectionIds';
import { useSession } from '../state/session';

/** The open workspace's or tests folder's connection id (connectionIds.ts), or undefined when nothing is open. */
export function currentWorkspaceId(): string | undefined {
  const { workspace, local } = useSession.getState();
  if (workspace) return workspaceConnectionId(workspace);
  if (local) return folderConnectionId(local.path);
  return undefined;
}

/** Whether a secret on this Mac may be used in `workspace` (as the shell's Policy::allowed_in). */
export function allowedIn(p: Pick<SecretPolicy, 'workspaces'> | undefined, workspace: string | undefined): boolean {
  return !p?.workspaces?.length || (!!workspace && p.workspaces.includes(workspace));
}

/** The open workspace's own secrets (names and flags), or [] (Community, a tests folder, no access). */
export async function workspaceSecretNames(): Promise<{ name: string; runnerCanUse: boolean }[]> {
  const backend = useSession.getState().backend;
  if (!edition.workspaceSecrets || !backend) return [];
  try { return await edition.workspaceSecrets.names(backend); } catch { return []; }
}

/**
 * Names the pickers offer here (Write saved secret, a call's header, a story's secrets): this
 * Mac's secrets allowed in the open workspace, and the workspace's own.
 */
export async function secretNamesHere(): Promise<string[]> {
  const ws = currentWorkspaceId();
  const [mine, shared] = await Promise.all([secrets.info().catch(() => [] as SecretPolicy[]), workspaceSecretNames()]);
  return [...new Set([...mine.filter(p => allowedIn(p, ws)).map(p => p.name), ...shared.map(s => s.name)])].sort();
}

/**
 * What a request carries for `names`: this Mac's values, where it happens, and the workspace's
 * sealed values for the names this Mac's secrets don't cover here.
 */
export async function secretsForRequest(names: string[]): Promise<SecretScope & { secrets: Record<string, string> }> {
  const workspace = currentWorkspaceId();
  const scope = workspace ? { workspace } : {};
  if (!names.length) return { secrets: {}, ...scope };
  const values = await secrets.resolve(names);
  const backend = useSession.getState().backend;
  if (!edition.workspaceSecrets || !backend) return { secrets: values, ...scope };
  const info = await secrets.info().catch(() => [] as SecretPolicy[]);
  const byName = new Map(info.map(p => [p.name, p]));
  const need = names.filter(n => !(n in values) || !allowedIn(byName.get(n), workspace));
  const shared = need.length ? await edition.workspaceSecrets.sealed(backend, need).catch(() => []) : [];
  return { secrets: values, ...scope, ...(shared.length ? { workspaceSecrets: shared } : {}) };
}

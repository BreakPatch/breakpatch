import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { edition } from '../edition';
import type { WorkspaceSecrets } from '../edition/types';
import { secrets } from '../platform';
import { DemoBackend, DEMO_WORKSPACE } from '../data/demo/demoBackend';
import { folderConnectionId } from '../state/connectionIds';
import { useSession } from '../state/session';
import { allowedIn, currentWorkspaceId, secretNamesHere, secretsForRequest } from './secretScope';

const FOLDER = '/Users/ana/Tests';
const HERE = folderConnectionId(FOLDER);
const ELSEWHERE = 'team:acme-tests/breakpatch';

let before: WorkspaceSecrets | undefined;
beforeEach(async () => {
  before = edition.workspaceSecrets;
  useSession.setState({ workspace: null, local: { path: FOLDER }, backend: new DemoBackend({ empty: true, signedIn: true, delayMs: 0 }) });
  await secrets.set('HERE_PW', 'here', { origins: ['https://app.example.com'], workspaces: [HERE] });
  await secrets.set('ACME_PW', 'acme', { origins: ['https://app.example.com'], workspaces: [ELSEWHERE] });
});
afterEach(async () => {
  edition.workspaceSecrets = before;
  vi.restoreAllMocks();
  await secrets.remove('HERE_PW'); await secrets.remove('ACME_PW');
});

describe('where saved secrets may be used (#33)', () => {
  it('knows the open workspace or tests folder by its connection id', () => {
    expect(currentWorkspaceId()).toBe(HERE);
    useSession.setState({ workspace: DEMO_WORKSPACE, local: null });
    expect(currentWorkspaceId()).toBe('demo');
    useSession.setState({ workspace: null, local: null });
    expect(currentWorkspaceId()).toBeUndefined();
  });

  it('keeps every secret saved before working everywhere until it is limited', () => {
    expect(allowedIn({}, HERE)).toBe(true);
    expect(allowedIn({ workspaces: [] }, undefined)).toBe(true);
    expect(allowedIn({ workspaces: [HERE] }, HERE)).toBe(true);
    expect(allowedIn({ workspaces: [ELSEWHERE] }, HERE)).toBe(false);
    expect(allowedIn({ workspaces: [HERE] }, undefined)).toBe(false);
  });

  it('offers only the secrets kept for this workspace, and every unlimited one', async () => {
    const names = await secretNamesHere();
    expect(names).toContain('HERE_PW');
    expect(names).toContain('ACME_TEST_EMAIL');         // the browser's sample secrets aren't limited
    expect(names).not.toContain('ACME_PW');
  });

  it('says where a request happens, and still sends this Mac\'s values for the shell to judge', async () => {
    const got = await secretsForRequest(['HERE_PW', 'ACME_PW']);
    expect(got).toEqual({ secrets: { HERE_PW: 'here', ACME_PW: 'acme' }, workspace: HERE });
    expect(await secretsForRequest([])).toEqual({ secrets: {}, workspace: HERE });
  });
});

describe("the workspace's own secrets (#45)", () => {
  const sealed = vi.fn(async (_b: unknown, names: string[]) => names.filter(n => n !== 'NOWHERE').map(name => ({ name, id: `id${name.length}`, enc: 'c2VhbGVk', kid: 1 })));

  beforeEach(() => {
    sealed.mockClear();
    edition.workspaceSecrets = { names: async () => [{ name: 'SHARED_PW', runnerCanUse: true }, { name: 'ACME_PW', runnerCanUse: false }], sealed };
  });

  it('asks the workspace only for the names this Mac has no secret for here', async () => {
    const got = await secretsForRequest(['HERE_PW', 'ACME_PW', 'SHARED_PW', 'NOWHERE']);
    expect(sealed).toHaveBeenCalledTimes(1);
    expect(sealed.mock.calls[0][1]).toEqual(['ACME_PW', 'SHARED_PW', 'NOWHERE']);
    expect(got.workspaceSecrets?.map(s => s.name)).toEqual(['ACME_PW', 'SHARED_PW']);
    expect(got.secrets.HERE_PW).toBe('here');
    expect(JSON.stringify(got.workspaceSecrets)).not.toMatch(/here|acme/);
  });

  it("doesn't ask when this Mac covers every name, and carries on when the workspace can't say", async () => {
    await secretsForRequest(['HERE_PW']);
    expect(sealed).not.toHaveBeenCalled();
    sealed.mockRejectedValueOnce(new Error('offline'));
    expect(await secretsForRequest(['SHARED_PW'])).toEqual({ secrets: {}, workspace: HERE });
  });

  it("lists the workspace's names in the pickers", async () => {
    const names = await secretNamesHere();
    expect(names).toContain('SHARED_PW');
    expect(names).toContain('ACME_PW');                 // the workspace's own, though this Mac's is kept elsewhere
  });
});

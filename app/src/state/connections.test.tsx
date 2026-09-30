// The connection list (connections.ts): built from session.v1 on first launch, kept in step with
// the session, and the title bar's switcher over it.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../components/ui';
import { WorkspaceSwitcher } from '../components/shell/WorkspaceSwitcher';
import { initFolder, previewStorage } from '../data/local';
import type { Workspace } from '../data/types';
import { CONNECTIONS_KEY, connections, folderConnection, folderConnectionId, loadConnections, useConnections, workspaceConnection, workspaceConnectionId } from './connections';
import { useSession } from './session';
import { edition } from '../edition';

const ws: Workspace = { name: 'Acme', domain: 'acme.com', database: 'breakpatch', config: { apiKey: 'k', authDomain: 'a', projectId: 'acme-qa', appId: '1' } };
const SESSION = 'breakpatch.session.v1';

beforeEach(() => { localStorage.clear(); connections.reloadForTests(); });
afterEach(() => { cleanup(); localStorage.clear(); useSession.setState({ workspace: null, local: null, backend: null, user: null }); });

describe('the connection list', () => {
  it('is built from session.v1 on first launch: a tests folder is the personal space', () => {
    localStorage.setItem(SESSION, JSON.stringify({ workspace: null, local: { path: '/Users/ana/web/tests' }, setupDone: true, prefs: {} }));
    const s = loadConnections();
    expect(s.list).toEqual([expect.objectContaining({ id: folderConnectionId('/Users/ana/web/tests'), kind: 'local', personal: true, name: 'tests', local: { path: '/Users/ana/web/tests' } })]);
    expect(s.activeId).toBe(s.list[0].id);
    expect(JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!)).toEqual(s);
  });

  it('is built from a saved Team workspace, with an id that is also its licence key', () => {
    localStorage.setItem(SESSION, JSON.stringify({ workspace: ws, setupDone: true, prefs: {} }));
    const s = loadConnections();
    expect(s.list[0]).toMatchObject({ id: 'team:acme-qa/breakpatch', kind: 'team', name: 'Acme', team: { workspace: ws } });
    expect(workspaceConnectionId({ ...ws, config: { ...ws.config, apiKey: 'demo' } })).toBe('demo');
  });

  it('starts empty on a new Mac, and follows session.v1 when an older app changed it', () => {
    expect(loadConnections()).toEqual({ list: [], activeId: null });
    connections.opened(workspaceConnection(ws));
    // An older version (after a downgrade) opened a tests folder and wrote only session.v1.
    localStorage.setItem(SESSION, JSON.stringify({ workspace: null, local: { path: '/Users/ana/web/tests' } }));
    const s = loadConnections();
    expect(s.list.map(c => c.id)).toEqual(['team:acme-qa/breakpatch', folderConnectionId('/Users/ana/web/tests')]);
    expect(s.activeId).toBe(folderConnectionId('/Users/ana/web/tests'));
  });

  it('finds the same connection when the same thing is opened again, and forgets one on request', () => {
    connections.opened(folderConnection('/Users/ana/web/tests/'));
    connections.opened(workspaceConnection(ws));
    connections.opened(folderConnection('/Users/ana/web/tests', 'Web tests'));
    const { list, activeId } = useConnections.getState();
    expect(list).toHaveLength(2);
    expect(list.find(c => c.kind === 'local')?.name).toBe('Web tests');
    expect(activeId).toBe(folderConnectionId('/Users/ana/web/tests'));
    connections.remove(activeId!);
    expect(useConnections.getState()).toMatchObject({ activeId: null, list: [expect.objectContaining({ kind: 'team' })] });
  });

  it('keeps a kind a newer version made (a hosted workspace) and never offers to open it', () => {
    const hosted = { id: 'hosted:ws_7f3a', kind: 'hosted', name: 'Acme Cloud', lastOpenedAt: 1 };
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify({ list: [hosted], activeId: null }));
    expect(loadConnections().list).toEqual([hosted]);
    connections.reloadForTests();
    connections.opened(folderConnection('/Users/ana/web/tests'));
    expect(JSON.parse(localStorage.getItem(CONNECTIONS_KEY)!).list.map((c: { id: string }) => c.id)).toContain('hosted:ws_7f3a');
  });

  it('ignores a broken list', () => {
    localStorage.setItem(CONNECTIONS_KEY, JSON.stringify({ list: [{ id: 'x' }, 42], activeId: 'x' }));
    expect(loadConnections()).toEqual({ list: [], activeId: null });
  });
});

describe('the session keeps the list in step', () => {
  it('opening a folder adds the personal space, and session.v1 is still written for it', async () => {
    const path = '/Users/you/Projects/other-tests';
    await previewStorage().mkdir(path);
    await initFolder(previewStorage(), path);
    await useSession.getState().connectLocal(path);
    expect(useConnections.getState().activeId).toBe(folderConnectionId(path));
    expect(JSON.parse(localStorage.getItem(SESSION)!).local).toEqual({ path });
    useSession.getState().disconnect();
    expect(useConnections.getState()).toEqual({ list: [], activeId: null });
  });
});

describe('the switcher', () => {
  const show = () => render(<ToastProvider><MemoryRouter><WorkspaceSwitcher /></MemoryRouter></ToastProvider>);

  // Team adds "Connect a workspace" to it, so it shows there with one tests folder too.
  it.skipIf(edition.name === 'team')("says nothing while there's nowhere else to go", () => {
    connections.opened(folderConnection('/Users/ana/web/tests'));
    show();
    expect(screen.queryByRole('button', { name: /Switch workspace/ })).toBeNull();
  });

  it('lists the personal space first and opens another folder', async () => {
    const a = '/Users/you/Projects/a-tests', b = '/Users/you/Projects/b-tests';
    for (const p of [a, b]) { await previewStorage().mkdir(p); await initFolder(previewStorage(), p); }
    await useSession.getState().connectLocal(a);
    await useSession.getState().connectLocal(b);
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Workspace: Personal: b-tests. Switch workspace' }));
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map(i => i.textContent)).toEqual(['folderPersonal: a-tests', 'folderPersonal: b-testscheck']);
    fireEvent.click(items[0]);
    await waitFor(() => expect(useSession.getState().local?.path).toBe(a));
    expect(useConnections.getState().activeId).toBe(folderConnectionId(a));
  });
});

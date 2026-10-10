// Links that open a test in the right workspace (lib/openLinks.ts, public roadmap #32): Copy link
// on a test's and a suite's menu, and a link clicked elsewhere switching to its tests folder and
// opening the test; a plain message when it can't.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../ui';
import { initFolder, previewStorage, readFolderId } from '../../data/local';
import { DemoBackend } from '../../data/demo/demoBackend';
import type { Test } from '../../data/types';
import { connections } from '../../state/connections';
import { useSession } from '../../state/session';
import { useSystem } from '../../state/system';
import { openLinkFor } from '../../lib/openLinks';
import { TestsTab } from '../../screens/app/TestsTab';
import SuitesScreen from '../../screens/suites/SuitesScreen';
import { handleOpenLink, OpenLinks, usePendingLink } from './OpenLinks';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
const A = '/Users/you/Projects/links-a', B = '/Users/you/Projects/links-b';
const idle = { pathname: '/', lock: null, navigate: () => {} };

let copied: string[];
beforeEach(async () => {
  localStorage.clear(); connections.reloadForTests();
  for (const p of [A, B]) { await previewStorage().remove(p); await previewStorage().mkdir(p); await initFolder(previewStorage(), p); }
  copied = [];
  vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async (t: string) => { copied.push(t); } } });
  useSession.setState({ setupDone: true });
});
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  useSession.getState().backend?.close?.();
  useSession.setState({ workspace: null, local: null, backend: null, user: null });
  useSystem.setState({ error: null });
  usePendingLink.setState({ pending: null });
});

/** Folder B with one test; then folder A is the one open. */
async function twoFolders(): Promise<{ appId: string; test: Test }> {
  await useSession.getState().connectLocal(B);
  const b = useSession.getState().backend!;
  const app = await b.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  const test = await b.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
  await useSession.getState().connectLocal(A);
  return { appId: app.id, test };
}

function Where() { const l = useLocation(); return <div data-testid="where">{l.pathname}</div>; }
const showLinks = () => render(<MemoryRouter><OpenLinks /><Where /></MemoryRouter>);

describe('Copy link', () => {
  it("on a test's menu: a link naming the tests folder by its own id, which opens the test", async () => {
    await useSession.getState().connectLocal(A);
    const b = useSession.getState().backend!;
    const app = await b.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
    const test = await b.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    render(<ToastProvider><MemoryRouter><TestsTab app={app} tests={[test]} /></MemoryRouter></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'More for Log in' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy link/ }));
    await waitFor(() => expect(copied).toHaveLength(1));
    const id = await readFolderId(A);
    expect(copied[0]).toBe(`breakpatch://open?ws=folder:${id}&path=apps/${app.id}/tests/${test.id}`);
    expect(await screen.findByText('Link to Log in copied. It opens wherever this tests folder is open.')).toBeInTheDocument();
  });

  it("on a suite's menu, in a workspace: the workspace's id", async () => {
    const backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
    useSession.setState({ backend, workspace: backend.workspace, local: null, user: backend.currentUser() });
    const s = await backend.saveSuite(null, { name: 'Smoke', tests: [], schedule: null });
    render(<ToastProvider><MemoryRouter><SuitesScreen /></MemoryRouter></ToastProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'More for Smoke' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Copy link/ }));
    await waitFor(() => expect(copied).toEqual([`breakpatch://open?ws=demo&path=suites/${s.id}`]));
  });
});

describe('a link clicked elsewhere', () => {
  it('switches to the tests folder that has it, wherever it is on this Mac, and opens the test', async () => {
    const { appId, test } = await twoFolders();
    const link = openLinkFor(`folder:${(await readFolderId(B))!}`, { kind: 'test', appId, testId: test.id });
    showLinks();
    await handleOpenLink(link, idle);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/apps/${appId}/tests/${test.id}/record`));
    expect(useSession.getState().local?.path).toBe(B);
    expect(useSystem.getState().error).toBeNull();
  });

  it('opens a test in the folder open now without switching', async () => {
    await twoFolders();
    await useSession.getState().connectLocal(B);
    const before = useSession.getState().backend;
    showLinks();
    await handleOpenLink(openLinkFor(`folder:${(await readFolderId(B))!}`, { kind: 'suite', suiteId: 'smoke' }), idle);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/suites/smoke'));
    expect(useSession.getState().backend).toBe(before);
  });

  it("says so plainly when the folder isn't on this Mac, and when the link is broken", async () => {
    await twoFolders();
    await handleOpenLink('breakpatch://open?ws=folder:ffffffffffffffffffff&path=apps/web/tests/t1', idle);
    expect(useSystem.getState().error?.title).toBe("That tests folder isn't open on this Mac");
    expect(useSession.getState().local?.path).toBe(A);
    await handleOpenLink('breakpatch://open?ws=folder:ffffffffffffffffffff&path=apps/../tests/t1', idle);
    expect(useSystem.getState().error).toMatchObject({ title: "Couldn't open the link", reason: 'The link is incomplete or was changed. Ask for a new one.' });
    expect(usePendingLink.getState().pending).toBeNull();
  });

  it("doesn't take the person away from a recording or a run, or switch while switching is locked", async () => {
    const { appId, test } = await twoFolders();
    const link = openLinkFor(`folder:${(await readFolderId(B))!}`, { kind: 'test', appId, testId: test.id });
    await handleOpenLink(link, { ...idle, pathname: `/apps/${appId}/tests/other/record` });
    expect(useSystem.getState().error?.title).toBe('Finish what’s running first');
    useSystem.setState({ error: null });
    await handleOpenLink(link, { ...idle, lock: 'This Mac is the local runner.' });
    expect(useSystem.getState().error).toMatchObject({ title: "Couldn't switch workspace", reason: 'This Mac is the local runner.' });
    expect(useSession.getState().local?.path).toBe(A);
    expect(usePendingLink.getState().pending).toBeNull();
  });

  it('waits for the workspace to be open, signed in and set up before opening the test', async () => {
    await twoFolders();
    await useSession.getState().connectLocal(B);
    // As a Team workspace is before its person signs in (the gate shows Sign in).
    const user = useSession.getState().user;
    useSession.setState({ user: null });
    showLinks();
    await handleOpenLink(openLinkFor(`folder:${(await readFolderId(B))!}`, { kind: 'suite', suiteId: 's1' }), idle);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/$/);
    useSession.setState({ user });
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/suites/s1'));
  });
});

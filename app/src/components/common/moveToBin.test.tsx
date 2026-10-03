// Deleting goes straight to Recently deleted, with Undo and Open Recently deleted in the toast
// (moveToBin.ts); the suite editor names its tests that are in Recently deleted and can put them back.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_ACTIONS_MS, ToastProvider, useToast } from '../ui';
import type { App, Test } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { TestsTab } from '../../screens/app/TestsTab';
import SuiteEditorScreen from '../../screens/suites/SuiteEditorScreen';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
let backend: DemoBackend;
let app: App;

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, workspace: null, user: backend.currentUser() });
  app = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

const testsNow = () => new Promise<Test[]>(r => { const off = backend.tests(app.id, v => { setTimeout(off); r(v); }); });
function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }

describe('Deleting a test', () => {
  const open = (tests: Test[]) => render(
    <MemoryRouter><ToastProvider><TestsTab app={app} tests={tests} /><Where /></ToastProvider></MemoryRouter>);
  const del = (name: string) => {
    fireEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
  };

  it('goes at once, with no dialog, and Undo puts it back', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    open([t]);
    del('Log in');
    expect(screen.queryByRole('dialog')).toBeNull();
    await screen.findByText('"Log in" moved to Recently deleted.');
    expect(await testsNow()).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('"Log in" is back.');
    expect((await testsNow()).map(x => x.name)).toEqual(['Log in']);
  });

  it('offers the way to Recently deleted', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    open([t]);
    del('Log in');
    fireEvent.click(await screen.findByRole('button', { name: 'Open Recently deleted' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/deleted');
    // Pressing a button closes the toast.
    await waitFor(() => expect(screen.queryByText('"Log in" moved to Recently deleted.')).toBeNull());
  });
});

describe('A toast with buttons', () => {
  function Push({ actions }: { actions: boolean }) {
    const toast = useToast();
    return <button type="button" onClick={() => toast('Done.', actions ? { actions: [{ label: 'Undo', onClick: () => {} }] } : undefined)}>push</button>;
  }
  const push = (actions: boolean) => {
    render(<ToastProvider><Push actions={actions} /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'push' }));
  };

  it('stays long enough to press one, and longer than a plain toast', () => {
    vi.useFakeTimers();
    push(true);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(TOAST_ACTIONS_MS); });
    expect(screen.queryByText('Done.')).toBeNull();
  });

  it('stays while the pointer is on it', () => {
    vi.useFakeTimers();
    push(true);
    fireEvent.mouseEnter(screen.getByText('Done.').closest('.toast')!);
    act(() => { vi.advanceTimersByTime(TOAST_ACTIONS_MS * 2); });
    expect(screen.getByText('Done.')).toBeInTheDocument();
  });

  it('a plain one goes after a moment', () => {
    vi.useFakeTimers();
    push(false);
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByText('Done.')).toBeNull();
  });
});

describe('Suite editor: tests in Recently deleted', () => {
  it('names them, and Restore puts them back', async () => {
    const a = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    const b = await backend.createTest({ appId: app.id, name: 'Log out', startUrl: app.baseUrl, viewport: VP });
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: [{ appId: app.id, testId: a.id }, { appId: app.id, testId: b.id }], schedule: null });
    await backend.deleteTest(app.id, a.id);
    render(<MemoryRouter initialEntries={[`/suites/${suite.id}`]}><ToastProvider>
      <Routes><Route path="/suites/:suiteId" element={<SuiteEditorScreen />} /></Routes>
    </ToastProvider></MemoryRouter>);
    await screen.findByText(/^"Log in" is in Recently deleted\./);
    expect(screen.getByRole('button', { name: 'Open Recently deleted' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(screen.queryByText(/is in Recently deleted/)).toBeNull());
    expect((await testsNow()).map(x => x.name).sort()).toEqual(['Log in', 'Log out']);
  });
});

// Deleting goes straight to Recently deleted, with Undo (⌘Z too) and Show (Recently deleted) in the toast
// (moveToBin.ts); the suite editor names its tests that are in Recently deleted and can put them back.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOAST_ACTIONS_MS, TOAST_ERROR_MS, TOAST_MAX, ToastProvider, useToast } from '../ui';
import { setOsForTests } from '../../lib/osWords';
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
    fireEvent.click(await screen.findByRole('button', { name: 'Show Recently deleted' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/settings/deleted');
    // Pressing a button closes the toast.
    await waitFor(() => expect(screen.queryByText('"Log in" moved to Recently deleted.')).toBeNull());
  });

  it('the toast goes once the test is put back another way, so its Undo is never stale (DESK-01)', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    open([t]);
    del('Log in');
    await screen.findByRole('button', { name: 'Undo' });
    await act(async () => { await backend.recentlyDeleted!.restore({ kind: 'test', id: t.id, appId: app.id }); });
    await waitFor(() => expect(screen.queryByText('"Log in" moved to Recently deleted.')).toBeNull());
    expect(screen.queryByText(/no longer in Recently deleted/)).toBeNull();
  });

  it('⌘Z undoes it while the toast shows, and the toast says so', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    open([t]);
    del('Log in');
    const undo = await screen.findByRole('button', { name: 'Undo' });
    expect(undo).toHaveAttribute('aria-keyshortcuts', 'Meta+Z');
    expect(undo).toHaveTextContent('Undo⌘Z');
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    await screen.findByText('"Log in" is back.');
    expect((await testsNow()).map(x => x.name)).toEqual(['Log in']);
  });

  it('⌘Z in a text field is the field’s own undo', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    open([t]);
    del('Log in');
    await screen.findByRole('button', { name: 'Undo' });
    const box = screen.getByPlaceholderText('Search tests');
    fireEvent.keyDown(box, { key: 'z', metaKey: true });
    expect(await testsNow()).toEqual([]);
    expect(screen.queryByText('"Log in" is back.')).toBeNull();
  });

  it('puts focus on the next row once the row has gone', async () => {
    const a = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    const b = await backend.createTest({ appId: app.id, name: 'Log out', startUrl: app.baseUrl, viewport: VP });
    const { rerender } = open([a, b]);
    fireEvent.click(screen.getByRole('button', { name: 'More for Log in' }));
    const item = screen.getByRole('menuitem', { name: 'Delete' });
    item.focus();
    fireEvent.click(item);
    await screen.findByText('"Log in" moved to Recently deleted.');
    rerender(<MemoryRouter><ToastProvider><TestsTab app={app} tests={[b]} /><Where /></ToastProvider></MemoryRouter>);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('row', { name: 'Log out, open in the recorder' })));
  });

  it('after Undo from the keyboard, focus goes back where it was', async () => {
    const a = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    open([a]);
    del('Log in');
    const before = screen.getByPlaceholderText('Search tests');
    before.focus();
    const undo = await screen.findByRole('button', { name: 'Undo' });
    undo.focus();
    fireEvent.click(undo);
    await waitFor(() => expect(document.activeElement).toBe(before));
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

describe('Only the newest toast with Undo answers ⌘Z', () => {
  function Push() {
    const toast = useToast();
    return <>
      <button type="button" onClick={() => toast('First.', { actions: [{ label: 'Undo', undo: true, onClick: first }] })}>one</button>
      <button type="button" onClick={() => toast('Second.', { actions: [{ label: 'Undo', undo: true, onClick: second }] })}>two</button>
    </>;
  }
  const first = vi.fn(), second = vi.fn();
  it('runs the newest, then the one before', () => {
    render(<ToastProvider><Push /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    fireEvent.click(screen.getByRole('button', { name: 'two' }));
    const undos = screen.getAllByRole('button', { name: 'Undo' });
    expect(undos[0]).not.toHaveAttribute('aria-keyshortcuts');     // only the newest says ⌘Z
    expect(undos[1]).toHaveAttribute('aria-keyshortcuts', 'Meta+Z');
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
    expect(first).toHaveBeenCalledTimes(1);
  });

  it('is Ctrl+Z off the Mac', () => {
    setOsForTests('windows');
    try {
      render(<ToastProvider><Push /></ToastProvider>);
      fireEvent.click(screen.getByRole('button', { name: 'one' }));
      expect(screen.getByRole('button', { name: 'Undo' })).toHaveTextContent('UndoCtrl+Z');
      first.mockClear();
      fireEvent.keyDown(document.body, { key: 'z', metaKey: true });
      expect(first).not.toHaveBeenCalled();                            // ⌘ isn't the shortcut key here
      fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
      expect(first).toHaveBeenCalledTimes(1);
    } finally { setOsForTests(null); }
  });
});

describe('A stack of toasts', () => {
  it('keeps the newest few: a new one pushes the oldest out', async () => {
    function Push() { const toast = useToast(); let n = 0; return <button type="button" onClick={() => toast(`Toast ${++n}.`)}>push</button>; }
    render(<ToastProvider><Push /></ToastProvider>);
    for (let i = 0; i < TOAST_MAX + 2; i++) { fireEvent.click(screen.getByRole('button', { name: 'push' })); await act(async () => {}); }
    await waitFor(() => expect(document.querySelectorAll('.toast').length).toBe(TOAST_MAX));
    expect(screen.getByText(`Toast ${TOAST_MAX + 2}.`)).toBeInTheDocument();
    expect(screen.queryByText('Toast 1.')).toBeNull();
  });
});

describe('An error toast', () => {
  it('stays long enough to read', () => {
    vi.useFakeTimers();
    function Push() { const toast = useToast(); return <button type="button" onClick={() => toast('Couldn’t save.', { error: true })}>push</button>; }
    render(<ToastProvider><Push /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'push' }));
    act(() => { vi.advanceTimersByTime(TOAST_ERROR_MS - 100); });
    expect(screen.getByText('Couldn’t save.')).toBeInTheDocument();
    expect(TOAST_ERROR_MS).toBeGreaterThanOrEqual(6000);
  });
});

describe('Deleting a suite with edits not saved yet', () => {
  it('saves them first, so Undo brings it back as it was on screen', async () => {
    const a = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: [{ appId: app.id, testId: a.id }], schedule: null });
    render(<MemoryRouter initialEntries={[`/suites/${suite.id}`]}><ToastProvider>
      <Routes><Route path="/suites/:suiteId" element={<SuiteEditorScreen />} /><Route path="/suites" element={<div>Suites</div>} /></Routes>
    </ToastProvider></MemoryRouter>);
    const name = await screen.findByDisplayValue('Smoke');
    fireEvent.change(name, { target: { value: 'Smoke, nightly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Delete suite' }));
    await screen.findByText('"Smoke, nightly" moved to Recently deleted.');
    expect(screen.queryByText('Suite saved.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await screen.findByText('"Smoke, nightly" is back.');
    const back = await new Promise<{ name: string }[]>(r => { const off = backend.suites(v => { setTimeout(off); r(v); }); });
    expect(back.map(s => s.name)).toEqual(['Smoke, nightly']);
  });
});

describe('Putting a test back (DESK-04)', () => {
  it('comes back in its old place in the app’s list, not at the end', async () => {
    const mk = (name: string) => backend.createTest({ appId: app.id, name, startUrl: app.baseUrl, viewport: VP });
    const [, b] = [await mk('One'), await mk('Two'), await mk('Three')];
    await backend.deleteTest(app.id, b.id);
    await backend.recentlyDeleted!.restore({ kind: 'test', id: b.id, appId: app.id });
    expect((await testsNow()).map(x => x.name)).toEqual(['One', 'Two', 'Three']);
  });
});

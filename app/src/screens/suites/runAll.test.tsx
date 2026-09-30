// Run all on the app screen: every test of the app, one after another, in the suite run view
// (/apps/:appId/run-all), in Community (no workspace, local suites) and in Team alike.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Step } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { getEngine, type EngineEvents, type RunStart } from '../../engine';
import { notificationFor } from '../../lib/notify';
import SuiteRunScreen from './SuiteRunScreen';
import BreakpatchApp from '../../App';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
Element.prototype.scrollIntoView ??= () => undefined;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
const step = (id: string): Step => ({ id, action: 'click', label: `Click ${id}`, at: [10, 10] });
let backend: DemoBackend;
let web: App;
let other: App;
let started: RunStart[];

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, workspace: null });
  web = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  other = await backend.addApp({ name: 'Site', baseUrl: 'https://www.example.com', defaultViewport: VP });
  for (const [app, name, fail] of [[web, 'Log in', false], [web, 'Create a project', true], [web, 'Log out', false], [other, 'Sign up', false]] as const) {
    const t = await backend.createTest({ appId: app.id, name, startUrl: app.baseUrl, viewport: VP });
    await backend.saveTest(app.id, t.id, [step(fail ? 'bad' : 'ok')]);
  }
  // A quick engine: every step passes, except "bad".
  started = [];
  const engine = getEngine() as unknown as { emit<K extends keyof EngineEvents>(e: K, d: EngineEvents[K]): void };
  vi.spyOn(getEngine(), 'startRun').mockImplementation(async r => {
    started.push(r);
    setTimeout(() => {
      const fail = r.steps.some(s => s.id === 'bad');
      engine.emit('run.ended', { runId: r.runId, result: fail ? 'fail' : 'pass', durationMs: 5,
        steps: r.steps.map(s => ({ stepId: s.id, result: s.id === 'bad' ? 'failed' as const : 'passed' as const, ...(s.id === 'bad' ? { reason: 'targetNotFound' as const } : {}) })) });
    }, 0);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.location.hash = ''; useSession.setState({ local: null, user: null }); });

const open = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/apps/:appId/run-all" element={<SuiteRunScreen />} />
      <Route path="/suites/:suiteId/run" element={<SuiteRunScreen />} />
    </Routes>
  </MemoryRouter>);

describe('Run all', () => {
  it('the app screen opens the run of every test, not the first test', async () => {
    // The whole app, on the app screen of a tests folder that is set up.
    useSession.setState({ backend, workspace: null, local: { path: '/Users/ana/tests' }, user: backend.currentUser(), setupDone: true });
    window.location.hash = `#/apps/${web.id}`;
    render(<BreakpatchApp />);
    const runAll = await screen.findByRole('button', { name: 'Run all' }, { timeout: 4000 });   // the whole app: slower to start
    await waitFor(() => expect(runAll).toBeEnabled(), { timeout: 4000 });   // once the tests are there
    fireEvent.click(runAll);
    await waitFor(() => expect(window.location.hash).toBe(`#/apps/${web.id}/run-all`), { timeout: 4000 });
    expect(await screen.findByRole('complementary', { name: 'All tests in Web app' }, { timeout: 4000 })).toBeInTheDocument();
    await waitFor(() => expect(started).toHaveLength(3), { timeout: 4000 });
  });

  it('leaves out tests with no steps yet, so they don\'t fail the run', async () => {
    await backend.createTest({ appId: web.id, name: 'Draft', startUrl: web.baseUrl, viewport: VP });
    const failed = vi.spyOn(getEngine(), 'startRun');
    open(`/apps/${web.id}/run-all`);
    const side = await screen.findByRole('complementary', { name: 'All tests in Web app' });
    await waitFor(() => expect(within(side).getByText('3 of 3')).toBeInTheDocument(), { timeout: 4000 });
    expect(within(side).getAllByRole('listitem').map(r => r.getAttribute('aria-label'))).not.toContain(expect.stringContaining('Draft'));
    expect(within(side).getByText(/1 test with no steps yet left out/)).toBeInTheDocument();
    expect(failed).toHaveBeenCalledTimes(3);
    expect(screen.getByText('1 test failed')).toBeInTheDocument();       // only Create a project
  });

  it('an app with only tests that have no steps says so, and runs nothing', async () => {
    const drafts = await backend.addApp({ name: 'Drafts', baseUrl: 'https://d.example.com', defaultViewport: VP });
    await backend.createTest({ appId: drafts.id, name: 'Draft', startUrl: drafts.baseUrl, viewport: VP });
    open(`/apps/${drafts.id}/run-all`);
    expect(await screen.findByText('No recorded tests for Drafts yet.')).toBeInTheDocument();
    expect(screen.getByText("Record a test's steps first, then run them all.")).toBeInTheDocument();
    expect(started).toEqual([]);
  });

  it('doesn\'t say "no tests" while the app\'s tests are still loading', async () => {
    let release: (() => void) | undefined;
    const real = backend.tests.bind(backend);
    vi.spyOn(backend, 'tests').mockImplementation((appId, l) => {
      let off = () => {};
      release = () => { off = real(appId, l); };
      return () => off();
    });
    open(`/apps/${web.id}/run-all`);
    expect(await screen.findByText('Getting the tests ready')).toBeInTheDocument();
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByText(/No tests for/)).not.toBeInTheDocument();
    expect(started).toEqual([]);
    release!();
    const side = await screen.findByRole('complementary', { name: 'All tests in Web app' });
    await waitFor(() => expect(within(side).getByText('3 of 3')).toBeInTheDocument(), { timeout: 4000 });
    expect(screen.queryByText(/No tests for/)).not.toBeInTheDocument();
  });

  it('runs every test of the app one after another in one view, and saves each run', async () => {
    const addRun = vi.spyOn(backend, 'addRun');
    const addSuiteRun = vi.spyOn(backend, 'addSuiteRun');
    open(`/apps/${web.id}/run-all`);
    const side = await screen.findByRole('complementary', { name: 'All tests in Web app' });
    await waitFor(() => expect(within(side).getByText('3 of 3')).toBeInTheDocument(), { timeout: 4000 });
    // Only this app's tests, each once, in turn.
    expect(started.map(r => r.startUrl)).toEqual(['https://app.example.com', 'https://app.example.com', 'https://app.example.com']);
    const rows = within(side).getAllByRole('listitem').map(r => r.getAttribute('aria-label'));
    expect(rows).toEqual(expect.arrayContaining(['Log in, Web app, Passed', 'Create a project, Web app, Failed', 'Log out, Web app, Passed']));
    expect(rows).toHaveLength(3);
    expect(addRun).toHaveBeenCalledTimes(3);
    expect(within(side).getAllByRole('button', { name: /See the report for/ })).toHaveLength(3);
    // One combined result, like a suite; there's no saved suite to put it on.
    expect(await screen.findByText('1 test failed')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 tests passed. Open a failed test\'s report to see what happened.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('All tests · failed');
    expect(addSuiteRun).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });

  it('says so for an app with no tests or one that was deleted', async () => {
    const empty = await backend.addApp({ name: 'Empty', baseUrl: 'https://e.example.com', defaultViewport: VP });
    open(`/apps/${empty.id}/run-all`);
    expect(await screen.findByText('No tests for Empty yet.')).toBeInTheDocument();
    cleanup();
    open('/apps/gone/run-all');
    expect(await screen.findByText("This app isn't here any more.")).toBeInTheDocument();
    expect(started).toEqual([]);
  });

  it('a saved suite still runs its own tests and saves its result', async () => {
    const tests = await new Promise<{ appId: string; testId: string }[]>(r => { const off = backend.tests(web.id, l => { setTimeout(() => off()); r(l.map(t => ({ appId: web.id, testId: t.id }))); }); });
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: tests.slice(0, 1), schedule: null });
    const addSuiteRun = vi.spyOn(backend, 'addSuiteRun');
    open(`/suites/${suite.id}/run`);
    await waitFor(() => expect(addSuiteRun).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(addSuiteRun.mock.calls[0][0]).toMatchObject({ suiteId: suite.id, result: 'passed', counts: { total: 1, passed: 1 } });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Smoke · finished');
  });

  it('a notification names the app and points at its Runs tab', () => {
    const n = notificationFor({ kind: 'app', name: 'Web app', tests: 3, failed: 1, durationMs: 60_000, path: '/apps/web/?tab=runs' }, {}, false);
    expect(n).toMatchObject({ title: 'All tests in Web app: 1 of 3 failed', body: 'Open the Runs tab to see which.' });
    expect(notificationFor({ kind: 'app', name: 'Web app', tests: 3, failed: 0, durationMs: 60_000, path: '/' }, { notifyAll: true }, false)?.title)
      .toBe('All tests in Web app passed: 3 tests in 1 min');
  });
});

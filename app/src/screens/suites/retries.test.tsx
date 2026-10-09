// Retries in a suite run by hand (roadmap #14): the suite's setting reaches the engine, a test
// that passed on a retry says so, and the suite's result counts it as flaky without failing.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Step, Suite } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { getEngine, type EngineEvents, type RunStart } from '../../engine';
import { DEFAULT_RETRIES, retriesOf } from '../../lib/retries';
import SuiteRunScreen from './SuiteRunScreen';
import SuiteEditorScreen from './SuiteEditorScreen';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
const step = (id: string): Step => ({ id, action: 'click', label: `Click ${id}`, at: [10, 10] });
let backend: DemoBackend;
let web: App;
let refs: Suite['tests'];
let started: RunStart[];

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, workspace: null });
  web = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  refs = [];
  for (const [name, id] of [['Log in', 'ok'], ['Create a project', 'slow'], ['Pay', 'bad']] as const) {
    const t = await backend.createTest({ appId: web.id, name, startUrl: web.baseUrl, viewport: VP });
    await backend.saveTest(web.id, t.id, [step(id)]);
    refs.push({ appId: web.id, testId: t.id });
  }
  // "slow" fails its first try with a timeout and passes on the retry, when there is one; "bad" fails every try.
  started = [];
  const engine = getEngine() as unknown as { emit<K extends keyof EngineEvents>(e: K, d: EngineEvents[K]): void };
  vi.spyOn(getEngine(), 'startRun').mockImplementation(async r => {
    started.push(r);
    setTimeout(() => {
      const slow = r.steps.some(s => s.id === 'slow');
      const bad = r.steps.some(s => s.id === 'bad');
      const retries = r.settings.retries ?? 0;
      if (slow && retries > 0) {
        engine.emit('run.retry', { runId: r.runId, attempt: 2, of: retries + 1, stepId: 'slow', reason: 'timeout' });
        engine.emit('run.ended', { runId: r.runId, result: 'pass', durationMs: 5, attempts: 2,
          steps: [{ stepId: 'slow', result: 'passed', retried: [{ attempt: 1, reason: 'timeout', durationMs: 3 }] }] });
        return;
      }
      const fails = bad || slow;
      engine.emit('run.ended', { runId: r.runId, result: fails ? 'fail' : 'pass', durationMs: 5,
        steps: r.steps.map(s => ({ stepId: s.id, result: fails ? 'failed' as const : 'passed' as const, ...(fails ? { reason: (slow ? 'timeout' : 'targetNotFound') as 'timeout' } : {}) })) });
    }, 0);
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); useSession.setState({ local: null, user: null }); });

const open = (path: string) => render(
  <MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/suites/:suiteId/run" element={<SuiteRunScreen />} />
      <Route path="/suites/:suiteId" element={<SuiteEditorScreen />} />
    </Routes>
  </MemoryRouter>);

describe('retries in a suite run by hand', () => {
  it('a suite that says nothing retries once; the setting is 0 to 2', () => {
    expect(DEFAULT_RETRIES).toBe(1);
    expect([retriesOf({}), retriesOf({ retries: 0 }), retriesOf({ retries: 2 }), retriesOf({ retries: 7 }), retriesOf({ retries: 1.5 })]).toEqual([1, 0, 2, 1, 1]);
  });

  it('passes the suite\'s retries to the engine, says which test passed on a retry, and counts it as flaky', async () => {
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: refs.slice(0, 2), schedule: null, retries: 2 });
    const addSuiteRun = vi.spyOn(backend, 'addSuiteRun');
    const addRun = vi.spyOn(backend, 'addRun');
    open(`/suites/${suite.id}/run`);
    await waitFor(() => expect(addSuiteRun).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(started.map(r => r.settings.retries)).toEqual([2, 2]);
    expect(addSuiteRun.mock.calls[0][0]).toMatchObject({ result: 'passed', counts: { total: 2, passed: 2, failed: 0, flaky: 1 } });
    expect(addRun.mock.calls[1][0]).toMatchObject({ result: 'pass', attempts: 2 });
    const side = screen.getByRole('complementary', { name: 'Smoke tests' });
    const row = within(side).getByRole('listitem', { name: 'Create a project, Web app, Passed' });
    expect(within(row).getByText('Passed on retry 1')).toBeInTheDocument();
    expect(screen.getByText('All 2 tests worked. 1 of them passed only on a retry, so may be flaky.')).toBeInTheDocument();
  });

  it("Don't retry: the slow test fails and nothing is counted as flaky", async () => {
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: refs.slice(0, 2), schedule: null, retries: 0 });
    const addSuiteRun = vi.spyOn(backend, 'addSuiteRun');
    open(`/suites/${suite.id}/run`);
    await waitFor(() => expect(addSuiteRun).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(started.map(r => r.settings.retries)).toEqual([undefined, undefined]);
    expect(addSuiteRun.mock.calls[0][0].counts).toEqual({ total: 2, passed: 1, fixed: 0, failed: 1, notRun: 0 });
    expect(addSuiteRun.mock.calls[0][0].result).toBe('failed');
  });

  it('a real failure still fails the suite, with retries on', async () => {
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: refs, schedule: null });
    const addSuiteRun = vi.spyOn(backend, 'addSuiteRun');
    open(`/suites/${suite.id}/run`);
    await waitFor(() => expect(addSuiteRun).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(started.map(r => r.settings.retries)).toEqual([1, 1, 1]);   // the default
    expect(addSuiteRun.mock.calls[0][0]).toMatchObject({ result: 'failed', counts: { total: 3, passed: 2, failed: 1, flaky: 1 } });
  });

  it('the suite editor saves the choice', async () => {
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: refs.slice(0, 1), schedule: null });
    expect(suite.retries).toBeUndefined();
    const save = vi.spyOn(backend, 'saveSuite');
    open(`/suites/${suite.id}`);
    await screen.findByDisplayValue('Smoke');                       // the suite has loaded into the form
    const group = screen.getByRole('tablist', { name: 'When a test fails because the page was slow' });
    expect(within(group).getByRole('tab', { name: 'Retry once' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(group).getByRole('tab', { name: 'Retry twice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0][1]).toMatchObject({ retries: 2 });
  });
});

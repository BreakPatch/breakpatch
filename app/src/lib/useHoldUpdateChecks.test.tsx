// The screens keep automatic update checks back only while they're busy (lib/useHoldUpdateChecks.ts):
// a run while it runs, a suite from its first test to its last, the recorder while a step records or
// the test plays. A screen that's open but idle (a run that has ended) holds nothing.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Step, Test } from '../data/types';
import { DemoBackend } from '../data/demo/demoBackend';
import { useSession } from '../state/session';
import { getEngine, type EngineEvents, type RunStart } from '../engine';
import { ToastProvider } from '../components/ui';
import { useHoldUpdateChecks } from './useHoldUpdateChecks';
import RunScreen from '../screens/run/RunScreen';
import SuiteRunScreen from '../screens/suites/SuiteRunScreen';
import RecorderScreen from '../screens/recorder/RecorderScreen';
import { useRecorder } from '../screens/recorder/useRecorder';

/** How many holds are on the automatic checks now. */
const holds = vi.hoisted(() => ({ n: 0 }));
vi.mock('./autoUpdates', async orig => ({
  ...await orig<typeof import('./autoUpdates')>(),
  holdUpdateChecks: () => {
    holds.n++;
    let released = false;
    return () => { if (!released) { released = true; holds.n--; } };
  },
}));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
Element.prototype.scrollIntoView ??= () => undefined;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
const step = (id: string): Step => ({ id, action: 'click', label: `Click ${id}`, at: [10, 10] });
let backend: DemoBackend;
let app: App;
let tests: Test[];
/** Runs the engine has started and not yet ended. */
let running: RunStart[];

/** Ends the oldest run going on, every step passed. */
function finishRun() {
  const r = running.shift()!;
  const engine = getEngine() as unknown as { emit<K extends keyof EngineEvents>(e: K, d: EngineEvents[K]): void };
  act(() => engine.emit('run.ended', { runId: r.runId, result: 'pass', durationMs: 5, steps: r.steps.map(s => ({ stepId: s.id, result: 'passed' as const })) }));
}

beforeEach(async () => {
  holds.n = 0;
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, workspace: null });
  app = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  tests = [];
  for (const name of ['Log in', 'Log out']) {
    const t = await backend.createTest({ appId: app.id, name, startUrl: app.baseUrl, viewport: VP });
    await backend.saveTest(app.id, t.id, [step('a'), step('b')]);
    tests.push(t);
  }
  running = [];
  vi.spyOn(getEngine(), 'startRun').mockImplementation(async r => { running.push(r); });   // ends when finishRun says
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const open = (path: string) => render(
  <ToastProvider><MemoryRouter initialEntries={[path]}>
    <Routes>
      <Route path="/apps/:appId/tests/:testId/run" element={<RunScreen />} />
      <Route path="/apps/:appId/tests/:testId/record" element={<RecorderScreen />} />
      <Route path="/apps/:appId/run-all" element={<SuiteRunScreen />} />
    </Routes>
  </MemoryRouter></ToastProvider>);

describe('useHoldUpdateChecks', () => {
  it('holds while active, lets go when it isn\'t, and when the screen closes', () => {
    const { rerender, unmount } = renderHook(({ on }) => useHoldUpdateChecks(on), { initialProps: { on: false } });
    expect(holds.n).toBe(0);
    rerender({ on: true });
    expect(holds.n).toBe(1);
    rerender({ on: true });
    expect(holds.n).toBe(1);                                       // one hold, however often it renders
    rerender({ on: false });
    expect(holds.n).toBe(0);
    rerender({ on: true });
    unmount();
    expect(holds.n).toBe(0);
  });
});

describe('the screens hold update checks only while busy', () => {
  it('a test run holds them while it runs, and its finished screen holds nothing', async () => {
    open(`/apps/${app.id}/tests/${tests[0].id}/run`);
    await waitFor(() => expect(running).toHaveLength(1));
    expect(holds.n).toBe(1);
    finishRun();
    expect(await screen.findByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(holds.n).toBe(0);                                       // the screen stays open, idle
  });

  it('Run all holds them from the first test to the last, not between, and not once it has ended', async () => {
    open(`/apps/${app.id}/run-all`);
    await waitFor(() => expect(running).toHaveLength(1));
    expect(holds.n).toBe(1);
    finishRun();
    await waitFor(() => expect(running).toHaveLength(1));         // the second test
    expect(holds.n).toBe(1);
    finishRun();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('All tests · finished'));
    expect(holds.n).toBe(0);
  });

  it('the recorder holds nothing while it is just open, and holds them while the test plays', async () => {
    open(`/apps/${app.id}/tests/${tests[0].id}/record`);
    const run = await screen.findByRole('button', { name: 'Run' });
    await waitFor(() => expect(run).toBeEnabled());
    expect(holds.n).toBe(0);
    fireEvent.click(run);
    await waitFor(() => expect(running).toHaveLength(1));
    expect(holds.n).toBe(1);
    finishRun();
    await waitFor(() => expect(holds.n).toBe(0));
  });

  it("the recorder's `working` is a step being recorded, not the recorder being open", async () => {
    let answer!: (s: Step) => void;
    vi.spyOn(getEngine(), 'recordPoint').mockImplementation(() => new Promise(r => { answer = r; }));
    const { result } = renderHook(() => useRecorder({ viewport: VP, onError: vi.fn() }));
    act(() => { result.current.load([step('a')]); });
    expect(result.current.working).toBe(false);
    act(() => { result.current.pagePoint([5, 5], 1); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.working).toBe(true));
    await act(async () => { answer({ id: 'n1', action: 'click', label: 'Click New', at: [5, 5] }); });
    await waitFor(() => expect(result.current.working).toBe(false));
  });
});

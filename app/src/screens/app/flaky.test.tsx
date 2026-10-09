// The Flaky marker (roadmap #14) on the Tests tab and in the report: why, and the answer to it;
// and a run that passed on a retry says so in the report, its run history and the Runs tab.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App, Run, Step, Test } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { TestsTab } from './TestsTab';
import { RunsTab } from './RunsTab';
import ReportScreen from '../report/ReportScreen';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => undefined;
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
const STEPS: Step[] = [
  { id: 's1', action: 'click', label: 'Click New', target: 'New button', at: [10, 10], pre: { region: [0, 0, 20, 20], hash: 'x', tolerance: 6 } },
  { id: 's2', action: 'click', label: 'Click Done', target: 'Done button', at: [30, 30] },
];
let backend: DemoBackend;
let app: App;
let flaky: Test;
let steady: Test;
let t0 = Date.UTC(2026, 9, 1);

async function addRun(test: Test, result: 'pass' | 'fail', extra: Partial<Run> = {}) {
  t0 += 60_000;
  return backend.addRun({
    appId: app.id, testId: test.id, testName: test.name, testVersion: 1, startedBy: { uid: 'u', name: 'Maria Lopez', email: 'm@x' }, machine: 'Mac',
    source: 'desktop', startedAt: t0, durationMs: 4000, result, healedCount: 0,
    steps: result === 'pass' ? [{ stepId: 's1', result: 'passed', preDistance: 1 }, { stepId: 's2', result: 'passed' }]
      : [{ stepId: 's1', result: 'passed' }, { stepId: 's2', result: 'failed', reason: 'timeout' }],
    ...extra,
  });
}

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, workspace: null, user: backend.currentUser() });
  app = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  flaky = await backend.createTest({ appId: app.id, name: 'Create a project', startUrl: app.baseUrl, viewport: VP });
  steady = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
  for (const t of [flaky, steady]) await backend.saveTest(app.id, t.id, STEPS);
  for (const r of ['pass', 'fail', 'pass', 'fail', 'pass'] as const) await addRun(flaky, r);
  for (const r of ['pass', 'pass', 'fail'] as const) await addRun(steady, r);       // a real failure: not flaky
});
afterEach(() => { cleanup(); useSession.setState({ user: null }); });

const tests = () => new Promise<Test[]>(r => { const off = backend.tests(app.id, l => { setTimeout(() => off()); r(l); }); });

describe('the Flaky marker', () => {
  it('shows on a test that failed between passes, with why, and not on one that just started failing', async () => {
    render(<MemoryRouter><TestsTab app={app} tests={await tests()} /></MemoryRouter>);
    const row = (await screen.findByRole('row', { name: 'Create a project, open in the recorder' }));
    const chip = await within(row).findByRole('note');
    expect(chip).toHaveTextContent('Flaky');
    expect(chip).toHaveAttribute('title', 'It failed twice and passed 3 times in its last 5 runs of version 1, back and forth, with no change to the test.');
    expect(within(screen.getByRole('row', { name: 'Log in, open in the recorder' })).queryByRole('note')).toBeNull();
  });

  it('can be marked known flaky, which keeps it quieter, and taken back', async () => {
    const { rerender } = render(<MemoryRouter><TestsTab app={app} tests={await tests()} /></MemoryRouter>);
    const row = await screen.findByRole('row', { name: 'Create a project, open in the recorder' });
    await within(row).findByRole('note');
    fireEvent.click(within(row).getByRole('button', { name: 'More for Create a project' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as known flaky' }));
    await waitFor(async () => expect((await tests()).find(t => t.id === flaky.id)?.flakyMark).toMatchObject({ state: 'known', version: 1, by: 'Maria Lopez' }));
    rerender(<MemoryRouter><TestsTab app={app} tests={await tests()} /></MemoryRouter>);
    await waitFor(() => expect(within(screen.getByRole('row', { name: 'Create a project, open in the recorder' })).getByRole('note')).toHaveTextContent('Known flaky'));
    fireEvent.click(within(screen.getByRole('row', { name: 'Create a project, open in the recorder' })).getByRole('button', { name: 'More for Create a project' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Not known flaky any more' }));
    await waitFor(async () => expect((await tests()).find(t => t.id === flaky.id)?.flakyMark).toBeUndefined());
  });

  it("It's not flaky sets its runs aside", async () => {
    await backend.setFlakyMark(app.id, flaky.id, { state: 'not', version: 1, by: 'Maria Lopez', at: t0 });
    render(<MemoryRouter><TestsTab app={app} tests={await tests()} /></MemoryRouter>);
    await screen.findByRole('row', { name: 'Create a project, open in the recorder' });
    await new Promise(r => setTimeout(r, 20));
    expect(within(screen.getByRole('row', { name: 'Create a project, open in the recorder' })).queryByRole('note')).toBeNull();
  });
});

describe('a run that passed on a retry', () => {
  const report = (runId: string) => render(
    <MemoryRouter initialEntries={[`/apps/${app.id}/runs/${runId}`]}>
      <Routes><Route path="/apps/:appId/runs/:runId" element={<ReportScreen />} /></Routes>
    </MemoryRouter>);

  it('says so in the report, on the step that failed first, and shows the test is flaky', async () => {
    const run = await addRun(flaky, 'pass', { attempts: 2, steps: [{ stepId: 's1', result: 'passed', preDistance: 4 }, { stepId: 's2', result: 'passed', retried: [{ attempt: 1, reason: 'timeout' }] }] });
    report(run.id);
    expect(await screen.findByTestId('retry-note')).toHaveTextContent('Passed on retry 1: the first try failed. A test that passes only on a retry may be flaky.');
    const band = await screen.findByTestId('flaky');
    expect(band).toHaveTextContent('It passed only on a retry once.');
    await waitFor(() => expect(band).toHaveTextContent('It fails most often at step 2, Click Done.'));
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(await within(steps).findByText('Failed on try 1: Waited too long for the page. It passed on the next try.')).toBeInTheDocument();
    // Step 1's check passed 2 bits inside its tolerance: close to failing.
    expect(within(steps).getByText(/Passed, but only just/)).toBeInTheDocument();
    fireEvent.click(within(band).getByRole('button', { name: 'Is it flaky?' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Mark as known flaky' }));
    await waitFor(async () => expect((await tests()).find(t => t.id === flaky.id)?.flakyMark?.state).toBe('known'));
  });

  it('a steady test with one run that passed first time has no marker and no note', async () => {
    const other = await backend.createTest({ appId: app.id, name: 'Sign up', startUrl: app.baseUrl, viewport: VP });
    await backend.saveTest(app.id, other.id, STEPS);
    const run = await addRun(other, 'pass');
    report(run.id);
    await screen.findByRole('list', { name: 'Steps' });
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('retry-note')).toBeNull();
    expect(screen.queryByTestId('flaky')).toBeNull();
  });

  it('the Runs tab says which runs passed on a retry', async () => {
    const run = await addRun(flaky, 'pass', { attempts: 3 });
    render(<MemoryRouter><RunsTab app={app} runs={[run]} /></MemoryRouter>);
    expect(screen.getByText('Passed on retry 2')).toBeInTheDocument();
  });
});

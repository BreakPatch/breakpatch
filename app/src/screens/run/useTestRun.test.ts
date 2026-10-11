// engineRun: the screenshots a run hands back for saving are its last try's (roadmap #14).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step, Test } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { getEngine, type EngineEvents } from '../../engine';
import { engineRun } from './useTestRun';

const VP = { width: 1440, height: 900, dpr: 1 as const };
const steps: Step[] = [{ id: 'a', action: 'click', label: 'Click A', at: [1, 1] }, { id: 'b', action: 'click', label: 'Click B', at: [2, 2] }];
let backend: DemoBackend;
let test: Test;

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, workspace: null });
  const app = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  test = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: app.baseUrl, viewport: VP });
});
afterEach(() => { vi.restoreAllMocks(); });

/** The engine's events for a run, sent once it starts. */
function engineSends(events: (runId: string) => { [K in keyof EngineEvents]: [K, EngineEvents[K]] }[keyof EngineEvents][]) {
  const engine = getEngine() as unknown as { emit<K extends keyof EngineEvents>(e: K, d: EngineEvents[K]): void };
  vi.spyOn(getEngine(), 'startRun').mockImplementation(async r => {
    setTimeout(() => { for (const [e, d] of events(r.runId)) engine.emit(e, d as never); }, 0);
  });
}

describe("a run's screenshots", () => {
  it("leaves an earlier try's screenshot off a step that passed on the last try", async () => {
    engineSends(runId => [
      ['run.step', { runId, index: 0, stepId: 'a', state: 'failed', reason: 'timeout', screenshot: '/shots/001-a.png' }],
      ['run.retry', { runId, attempt: 2, of: 2, stepId: 'a', reason: 'timeout' }],
      ['run.step', { runId, index: 0, stepId: 'a', state: 'passed' }],
      ['run.step', { runId, index: 1, stepId: 'b', state: 'passed' }],
      ['run.ended', { runId, result: 'pass', durationMs: 5, attempts: 2, steps: [
        { stepId: 'a', result: 'passed', retried: [{ attempt: 1, reason: 'timeout', durationMs: 3, screenshotPath: '/shots/001-a.png' }] },
        { stepId: 'b', result: 'passed' }] }],
    ]);
    const got = await engineRun(backend, test, steps, 'r1', { retries: 1 });
    expect(got!.shots).toEqual({});
    expect(got!.ended.steps[0].retried![0].screenshotPath).toBe('/shots/001-a.png');
  });

  it("keeps the last try's own screenshot", async () => {
    engineSends(runId => [
      ['run.step', { runId, index: 0, stepId: 'a', state: 'failed', reason: 'timeout', screenshot: '/shots/001-a.png' }],
      ['run.retry', { runId, attempt: 2, of: 2, stepId: 'a', reason: 'timeout' }],
      ['run.step', { runId, index: 0, stepId: 'a', state: 'passed' }],
      ['run.step', { runId, index: 1, stepId: 'b', state: 'failed', reason: 'targetNotFound', screenshot: '/shots/002-b-try2.png' }],
      ['run.ended', { runId, result: 'fail', durationMs: 5, attempts: 2, steps: [{ stepId: 'a', result: 'passed' }, { stepId: 'b', result: 'failed', reason: 'targetNotFound' }] }],
    ]);
    const got = await engineRun(backend, test, steps, 'r2', { retries: 1 });
    expect(got!.shots).toEqual({ b: '/shots/002-b-try2.png' });
  });

  it("isn't changed by another run's retry", async () => {
    engineSends(runId => [
      ['run.step', { runId, index: 0, stepId: 'a', state: 'failed', reason: 'timeout', screenshot: '/shots/001-a.png' }],
      ['run.retry', { runId: 'someone-else', attempt: 2, of: 2, stepId: 'a', reason: 'timeout' }],
      ['run.ended', { runId, result: 'fail', durationMs: 5, steps: [{ stepId: 'a', result: 'failed', reason: 'timeout' }] }],
    ]);
    const got = await engineRun(backend, test, steps, 'r3');
    expect(got!.shots).toEqual({ a: '/shots/001-a.png' });
  });
});

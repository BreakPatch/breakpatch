// Runs one test on this Mac: loads its current steps (shared steps resolved), starts the engine,
// follows its events and writes the run. Shared by the Run view and the suite run view.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { startUrlOf, type Backend } from '../../data/backend';
import type { Person, RecordedOn, Run, Step, Test } from '../../data/types';
import { useBackend } from '../../data/hooks';
import { demoEngine, getEngine, type RunEnded, type RunStepEvent } from '../../engine';
import { sampleApp } from '../../components/live';
import { secrets } from '../../platform';
import { useSession } from '../../state/session';
import { hasFeature } from '../../edition';
import { ensureSecretSites } from '../../lib/secretSites';
import { first } from '../settings/secretUsage';
import { filesDir } from '../../lib/testFiles';
import { notifyFinished } from '../../lib/notify';
import { findStep, numberOf } from '../../components/steps';
import type { App } from '../../data/types';
import { backendGroupLoader, callSecretNames, preorder, resolveSteps, secretNames } from './resolve';
import { INITIAL_RUN, runReducer } from './runState';
import { demoFailIds, demoSeen } from './demo';

export interface Finished { ended: RunEnded; run: Run | null; steps: Step[] }

/** The test's current version with its shared steps filled in, where it was recorded and where it starts. */
export async function prepareTest(backend: Backend, test: Test): Promise<{ steps: Step[]; recordedOn?: RecordedOn; startUrl: string }> {
  const v = await backend.version(test.appId, test.id, test.currentVersion);
  return { steps: await resolveSteps(v?.steps ?? [], backendGroupLoader(backend, test.appId)), recordedOn: v?.recordedOn, startUrl: startUrlOf(test, v) };
}

/** Where a run from this Mac says it ran. The demo matches the sample runs ("Maria's MacBook Pro"). */
export function machineName(user: Person | null): string {
  const first = user?.name.split(/\s+/)[0];
  if (!first) return 'This Mac';
  return demoEngine() ? `${first}'s MacBook Pro` : `${first}'s Mac`;
}

let seq = 0;
const newRunId = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;

/** The app's base address: set-up and clean-up calls may only go to its hosts. */
async function appUrlOf(backend: Backend, test: Test): Promise<string> {
  try { return (await first<App[]>(l => backend.apps(l))).find(a => a.id === test.appId)?.baseUrl ?? test.startUrl; }
  catch { return test.startUrl; }
}

/**
 * Reads the saved secrets the steps and calls use, starts the engine run and waits for its end.
 * Shared by the Run view and the recorder's own Run and Play to here (`keepOpen`, `upToStepId`).
 */
export async function engineRun(backend: Backend, t: Test, steps: Step[], runId: string, opts: {
  keepOpen?: boolean; upToStepId?: string; fromStepId?: string; abandoned?: () => boolean;
  /** Where the test was recorded (its version's `recordedOn`), to compare with this system. */
  recordedOn?: RecordedOn;
  /** Where the version being run starts (startUrlOf); the test's start address by default. */
  startUrl?: string;
  /** Just before the engine starts, when the secrets are read. */
  onStart?: (at: number) => void;
  onStep?: (ev: RunStepEvent) => void;
} = {}): Promise<{ ended: RunEnded; startedAt: number; shots: Record<string, string> } | null> {
  const engine = getEngine();
  const { prefs } = useSession.getState();
  const fixing = hasFeature('autoFix');
  const names = [...new Set([...secretNames(steps), ...callSecretNames(t.setUp, t.cleanUp)])];
  const appUrl = await appUrlOf(backend, t);
  await ensureSecretSites(names, appUrl);
  const values = await secrets.resolve(names);
  if (opts.abandoned?.()) return null;
  const startedAt = Date.now();
  opts.onStart?.(startedAt);
  const shots: Record<string, string> = {};
  const ended = await new Promise<RunEnded>((resolve, reject) => {
    const offStep = engine.on('run.step', ev => {
      if (ev.runId !== runId) return;
      if (ev.screenshot) shots[ev.stepId] = ev.screenshot;
      opts.onStep?.(ev);
    });
    const offEnd = engine.on('run.ended', ev => { if (ev.runId !== runId) return; offStep(); offEnd(); resolve(ev); });
    engine.startRun({
      runId, startUrl: opts.startUrl ?? t.startUrl, appUrl, viewport: t.viewport, steps, setUp: t.setUp, cleanUp: t.cleanUp,
      settings: { autoFix: fixing && prefs.autoFix, failOnFix: fixing && prefs.failOnFix, allowSystemDifferences: prefs.allowSystemDifferences },
      secrets: values, ...(opts.recordedOn ? { recordedOn: opts.recordedOn } : {}),
      ...(filesDir(backend.local?.path) ? { filesDir: filesDir(backend.local?.path) } : {}),
      ...(opts.keepOpen ? { keepOpen: true } : {}), ...(opts.upToStepId ? { upToStepId: opts.upToStepId } : {}),
      ...(opts.fromStepId ? { fromStepId: opts.fromStepId } : {}),
    }).catch(err => { offStep(); offEnd(); reject(err); });
  });
  return { ended, startedAt, shots };
}

export const newRunIdForEditor = () => newRunId();

/** A local notification for a finished test run, when the settings and the window say so. */
export function notifyTestRun(t: Pick<Test, 'name'>, ended: RunEnded, steps: Step[], path: string) {
  const failed = ended.steps.filter(r => r.result === 'failed' && r.reason !== 'stopped')
    .map(r => r.stepId).filter(id => { const s = findStep(steps, id); return s && !(s.steps && (s.action === 'loop' || s.action === 'group')); }).pop();
  const step = failed ? findStep(steps, failed) : undefined;
  return notifyFinished({
    kind: 'test', name: t.name, result: ended.result, path,
    ...(step ? { failedAt: { number: numberOf(steps, step.id), label: step.label } } : {}),
  }, useSession.getState().prefs);
}

export class NoStepsError extends Error { constructor() { super('This test has no steps yet. Record some first.'); } }

export function useTestRun() {
  const backend = useBackend();
  const [view, dispatch] = useReducer(runReducer, INITIAL_RUN);
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const active = useRef<{ runId: string; abandoned: boolean } | null>(null);

  useEffect(() => {
    const engine = getEngine();
    const offStep = engine.on('run.step', ev => dispatch({ type: 'step', ev }));
    const offEnd = engine.on('run.ended', ev => dispatch({ type: 'ended', ev }));
    return () => {
      offStep(); offEnd();
      // Leaving the screen stops the run; it isn't saved, since nobody chose to stop it.
      const cur = active.current;
      if (cur) { cur.abandoned = true; void engine.stopRun(cur.runId).catch(() => {}); }
    };
  }, []);

  /** `notify: false` inside a suite: the suite says how it went as a whole. */
  const start = useCallback(async (t: Test, opts: { notify?: boolean } = {}): Promise<Finished | null> => {
    if (active.current) return null;
    dispatch({ type: 'prepare' });
    setTest(t); setRun(null); setSaveError(null);
    const handle = { runId: newRunId(), abandoned: false };
    active.current = handle;
    try {
      const { steps: resolved, recordedOn, startUrl } = await prepareTest(backend, t);
      setSteps(resolved);
      if (!resolved.length) throw new NoStepsError();
      const byId = new Map(preorder(resolved).map(s => [s.id, s]));
      const top = new Set(resolved.map(s => s.id));
      const demo = demoEngine();
      let willFail = false;
      if (demo) {
        demo.failStepIds = new Set(demoFailIds(resolved));
        willFail = demo.failStepIds.size > 0;
        sampleApp.reset();
      }
      const { user } = useSession.getState();
      const got = await engineRun(backend, t, resolved, handle.runId, {
        abandoned: () => handle.abandoned, recordedOn, startUrl,
        onStart: at => dispatch({ type: 'start', runId: handle.runId, ids: [...byId.keys()], at }),
        onStep: ev => {
          // The sample page follows the run. A run that will fail at the moved Done button
          // never gets the dialog open, like the prototype ("The dialog never opened").
          const s = byId.get(ev.stepId);
          if (demo && !willFail && s && top.has(s.id) && (ev.state === 'passed' || ev.state === 'healed')) sampleApp.perform(s, t.viewport);
        },
      });
      if (!got) return null;
      const { ended, startedAt, shots } = got;
      active.current = null;
      if (handle.abandoned) return { ended, run: null, steps: resolved };

      const healedCount = ended.steps.filter(s => s.result === 'healed' && !byId.get(s.stepId)?.steps).length;
      let saved: Run | null = null;
      try {
        saved = await backend.addRun({
          appId: t.appId, testId: t.id, testName: t.name, testVersion: t.currentVersion,
          startedBy: user ?? backend.currentUser() ?? { serviceAccount: machineName(null) },
          machine: machineName(user ?? backend.currentUser()), source: 'desktop', startedAt, durationMs: ended.durationMs,
          result: ended.result, healedCount,
          steps: ended.steps.map(s => (shots[s.stepId] && !s.screenshotPath ? { ...s, screenshotPath: shots[s.stepId] } : s)),
          ...(ended.systemMismatch ? { systemMismatch: ended.systemMismatch } : {}),
        });
        if (demo && ended.result === 'fail') demoSeen.set(saved.id, sampleApp.get());
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      }
      setRun(saved);
      if (opts.notify !== false && saved) void notifyTestRun(t, ended, resolved, `/apps/${t.appId}/runs/${saved.id}`);
      return { ended, run: saved, steps: resolved };
    } catch (e) {
      if (active.current === handle) active.current = null;
      if (!handle.abandoned) dispatch({ type: 'error', message: e instanceof Error ? e.message : "Couldn't start the run." });
      throw e;
    }
  }, [backend]);

  const stop = useCallback(() => {
    const cur = active.current;
    if (cur) void getEngine().stopRun(cur.runId).catch(() => {});
  }, []);

  return { view, steps, test, run, saveError, start, stop, busy: view.phase === 'starting' || view.phase === 'running' };
}

export type TestRun = ReturnType<typeof useTestRun>;

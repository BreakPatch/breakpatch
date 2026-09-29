// Run and Play to here inside the recorder: the test replays in the recorder's own browser, each
// row shows its status live, and the browser stays at the end state so recording goes on from
// there. The Run view stays for runs started anywhere else (test list, suites, schedules, runner).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { FailReason, Step, Test } from '../../data/types';
import { useBackend } from '../../data/hooks';
import { demoEngine, getEngine } from '../../engine';
import { sampleApp } from '../../components/live';
import { stripUi, type RowStatus } from '../../components/steps';
import { useSession } from '../../state/session';
import { backendGroupLoader, preorder, resolveSteps } from '../run/resolve';
import { INITIAL_RUN, rowStatus, runReducer, type RunView } from '../run/runState';
import { passNote, reasonText, slowNote, UNCHECKED_NOTE } from '../run/reasons';
import { engineRun, machineName, newRunIdForEditor, notifyTestRun } from '../run/useTestRun';

/** run: every step. play: steps 1 to N. step: just one step, on the page as it is. */
export type EditorRunMode = 'run' | 'play' | 'step';

export interface EditorRunDone {
  mode: EditorRunMode;
  result: 'pass' | 'fail';
  /** The step the run stopped at (the failed one), or the one played to. */
  stoppedAt?: string;
  /** The saved run, for "See report" (full runs of a saved test only). */
  runId?: string;
  /** Every step that passed in it (their "Not played since the change" note goes). */
  passedIds?: string[];
}

/**
 * "Add a step here" never plays anything: when the page isn't at that step (and wasn't set up by
 * hand), the floating bar says how to get it there.
 */
export function addStepHint(atStepId: string | null, id: string, manual: boolean, number: number | string): string | null {
  return atStepId === id || manual ? null : `The page isn't at step ${number}. Use Play to here, or Use the page, to get it there.`;
}

/** Row statuses and notes for the steps list, from a run's live state. */
export function editorStatuses(view: RunView, steps: Step[], mode: EditorRunMode | null, upTo?: string | null): { statuses: Record<string, RowStatus>; notes: Record<string, string> } {
  const statuses: Record<string, RowStatus> = {};
  const notes: Record<string, string> = {};
  if (view.phase !== 'running' && view.phase !== 'ended') return { statuses, notes };
  const byId = new Map(preorder(steps).map(s => [s.id, s]));
  // Play to here: the steps after the one played to aren't part of it, so they say nothing, not "Waiting" (DES-12).
  const order0 = preorder(steps).map(s => s.id);
  const stop = mode === 'play' && upTo ? order0.indexOf(upTo) : -1;
  const after = (id: string) => stop >= 0 && order0.indexOf(id) > stop;
  for (const [id, state] of Object.entries(view.states)) {
    if (!byId.has(id) || after(id)) continue;
    // Play to here: the steps after it simply didn't run; no "Not run" on each.
    if (mode !== 'run' && (state === 'notRun' || (view.phase === 'ended' && state === 'waiting'))) continue;
    if (mode === 'step' && state === 'waiting') continue;
    const st = rowStatus(state, view.reasons[id]);
    if (st) statuses[id] = st;
  }
  for (const [id, p] of Object.entries(view.passes ?? {})) { const t = passNote(p); if (t && byId.has(id)) notes[id] = t; }
  for (const id of Object.keys(view.unchecked ?? {})) if (byId.has(id)) notes[id] = UNCHECKED_NOTE;
  // Where a slow step's time went (also the note's tooltip).
  const order = preorder(steps).map(s => s.id);
  for (const [id, t] of Object.entries(view.timings ?? {})) {
    const i = order.indexOf(id);
    const text = slowNote(t, i > 0 ? i : undefined);
    if (text && byId.has(id) && !notes[id]) notes[id] = text;
  }
  if (view.failedId && byId.has(view.failedId) && view.reasons[view.failedId] !== 'stopped') {
    notes[view.failedId] = reasonText(view.reasons[view.failedId] as FailReason, byId.get(view.failedId)!);
  }
  return { statuses, notes };
}

export function useEditorRun({ test, steps }: { test: Test | null | undefined; steps: () => Step[] }) {
  const backend = useBackend();
  const [view, dispatch] = useReducer(runReducer, INITIAL_RUN);
  const [mode, setMode] = useState<EditorRunMode | null>(null);
  const [upTo, setUpTo] = useState<string | null>(null);
  const active = useRef<{ runId: string; abandoned: boolean } | null>(null);

  useEffect(() => () => {
    // Leaving the recorder stops a run in progress; nothing is saved.
    const cur = active.current;
    if (cur) { cur.abandoned = true; void getEngine().stopRun(cur.runId).catch(() => {}); }
  }, []);

  /** Runs every step (mode 'run') or steps up to and including `upTo` ('play'). Never saves the test. */
  const start = useCallback(async (m: EditorRunMode, opts: { upTo?: string; keepRun?: boolean } = {}): Promise<EditorRunDone | null> => {
    if (active.current || !test) return null;
    const handle = { runId: newRunIdForEditor(), abandoned: false };
    active.current = handle;
    setMode(m);
    setUpTo(opts.upTo ?? null);
    dispatch({ type: 'prepare' });
    try {
      // As edited, unsaved changes included; shared steps filled in, as in any run.
      const resolved = await resolveSteps(stripUi(steps()), backendGroupLoader(backend, test.appId));
      if (!resolved.length) throw new Error('This test has no steps yet. Record some first.');
      const ids = preorder(resolved).map(s => s.id);
      const top = new Map(resolved.map(s => [s.id, s]));
      const demo = demoEngine();
      if (demo) { demo.failStepIds = new Set(); sampleApp.reset(); }
      const got = await engineRun(backend, test, resolved, handle.runId, {
        keepOpen: true, upToStepId: m !== 'run' ? opts.upTo : undefined, fromStepId: m === 'step' ? opts.upTo : undefined,
        abandoned: () => handle.abandoned,
        onStart: at => dispatch({ type: 'start', runId: handle.runId, ids, at }),
        onStep: ev => {
          dispatch({ type: 'step', ev });
          const s = top.get(ev.stepId);
          if (demo && s && (ev.state === 'passed' || ev.state === 'healed')) sampleApp.perform(s, test.viewport);
        },
      });
      active.current = null;
      if (!got || handle.abandoned) return null;
      const { ended, startedAt, shots } = got;
      dispatch({ type: 'ended', ev: ended });
      const failed = ended.steps.filter(r => r.result === 'failed').pop()?.stepId;
      const done: EditorRunDone = { mode: m, result: ended.result, stoppedAt: failed ?? (m !== 'run' ? opts.upTo : undefined),
        passedIds: ended.steps.filter(r => r.result === 'passed' || r.result === 'healed').map(r => r.stepId) };
      // A full run of the saved test goes in the run history like any other, so its report opens.
      if (m === 'run' && opts.keepRun) {
        const { user } = useSession.getState();
        try {
          const run = await backend.addRun({
            appId: test.appId, testId: test.id, testName: test.name, testVersion: test.currentVersion,
            startedBy: user ?? backend.currentUser() ?? { serviceAccount: machineName(null) },
            machine: machineName(user ?? backend.currentUser()), source: 'desktop', startedAt, durationMs: ended.durationMs,
            result: ended.result, healedCount: ended.steps.filter(s => s.result === 'healed' && !top.get(s.stepId)?.steps).length,
            steps: ended.steps.map(s => (shots[s.stepId] && !s.screenshotPath ? { ...s, screenshotPath: shots[s.stepId] } : s)),
          });
          done.runId = run.id;
          void notifyTestRun(test, ended, resolved, `/apps/${test.appId}/runs/${run.id}`);
        } catch { /* the run still shows in the editor; only the report link is missing */ }
      }
      return done;
    } catch (e) {
      if (active.current === handle) active.current = null;
      dispatch({ type: 'error', message: e instanceof Error ? e.message : "Couldn't start the run." });
      throw e;
    }
  }, [backend, test, steps]);

  const stop = useCallback(() => {
    const cur = active.current;
    if (cur) void getEngine().stopRun(cur.runId).catch(() => {});
  }, []);

  return { view, mode, upTo, start, stop, running: view.phase === 'starting' || view.phase === 'running' };
}

export type EditorRun = ReturnType<typeof useEditorRun>;

// Live state of one test run (README "State (UI level)" → Run: status per step, current step,
// running, ended, failed at, elapsed), fed by the engine's run.step / run.ended events.
import type { FailReason, Point, Run, Step, StepRun } from '../../data/types';
import type { RunEnded, RunRetryEvent, RunStepEvent } from '../../engine';
import type { RowStatus } from '../../components/steps';

export type StepState = 'waiting' | 'running' | 'looking' | 'passed' | 'fixed' | 'failed' | 'notRun';

export interface RunView {
  phase: 'idle' | 'starting' | 'running' | 'ended' | 'error';
  runId?: string;
  /** Every step id in run order (pre-order walk). */
  ids: string[];
  states: Record<string, StepState>;
  reasons: Record<string, FailReason>;
  /** The step the engine is on. */
  currentId?: string;
  /** The first step that failed (not the loop or card around it). */
  failedId?: string;
  fixes: Record<string, { oldAt?: Point; newAt?: Point }>;
  screenshots: Record<string, string>;
  /** Steps that passed another way than matching the recording, and how (StepRun.passedBy); a Call step's reply. */
  passes: Record<string, Pick<StepRun, 'passedBy' | 'why' | 'reply'>>;
  /** Where each step's time went. */
  timings: Record<string, NonNullable<StepRun['timings']>>;
  /** Steps whose checks covered nothing. */
  unchecked: Record<string, string[]>;
  startedAt?: number;
  result?: 'pass' | 'fail';
  durationMs?: number;
  steps?: StepRun[];
  error?: string;
  /** The try running now, after a retry (engine "Retries"): 2 or 3. Unset on the first. */
  attempt?: number;
  /** The most tries this run can take, once it has retried. */
  of?: number;
  /** The earlier tries' failures, oldest first: which step and why. */
  retries: { attempt: number; stepId: string; reason?: FailReason }[];
}

export type RunAction =
  | { type: 'prepare' }
  | { type: 'start'; runId: string; ids: string[]; at: number }
  | { type: 'step'; ev: RunStepEvent }
  | { type: 'ended'; ev: RunEnded }
  | { type: 'retry'; ev: RunRetryEvent }
  | { type: 'error'; message: string };

export const INITIAL_RUN: RunView = { phase: 'idle', ids: [], states: {}, reasons: {}, fixes: {}, screenshots: {}, passes: {}, timings: {}, unchecked: {}, retries: [] };

/** What a try shows, cleared when the next one starts. */
const EMPTY_TRY = { reasons: {}, fixes: {}, screenshots: {}, passes: {}, timings: {}, unchecked: {}, currentId: undefined, failedId: undefined } satisfies Partial<RunView>;

const FROM_RESULT: Record<StepRun['result'], StepState> = { passed: 'passed', healed: 'fixed', failed: 'failed', notRun: 'notRun' };

export function runReducer(s: RunView, a: RunAction): RunView {
  switch (a.type) {
    case 'prepare': return { ...INITIAL_RUN, phase: 'starting' };
    case 'start':
      return { ...INITIAL_RUN, phase: 'running', runId: a.runId, ids: a.ids, startedAt: a.at, states: Object.fromEntries(a.ids.map(id => [id, 'waiting' as StepState])) };
    case 'error': return { ...s, phase: 'error', error: a.message, currentId: undefined };
    case 'retry': {
      // The try that failed is kept in `retries`; the next starts from the first step again.
      const ev = a.ev;
      if (ev.runId !== s.runId || s.phase !== 'running') return s;
      return {
        ...s, ...EMPTY_TRY, states: Object.fromEntries(s.ids.map(id => [id, 'waiting' as StepState])),
        attempt: ev.attempt, of: ev.of, retries: [...s.retries, { attempt: ev.attempt - 1, stepId: ev.stepId, ...(ev.reason ? { reason: ev.reason } : {}) }],
      };
    }
    case 'step': {
      const ev = a.ev;
      if (ev.runId !== s.runId || s.phase !== 'running') return s;
      const state: StepState = ev.state === 'healed' ? 'fixed' : ev.state;
      const next: RunView = { ...s, states: { ...s.states, [ev.stepId]: state } };
      if (state === 'running' || state === 'looking') next.currentId = ev.stepId;
      if (state === 'fixed') next.fixes = { ...s.fixes, [ev.stepId]: { oldAt: ev.oldAt, newAt: ev.newAt } };
      if (ev.screenshot) next.screenshots = { ...s.screenshots, [ev.stepId]: ev.screenshot };
      if (ev.timings) next.timings = { ...s.timings, [ev.stepId]: ev.timings };
      if (ev.unchecked?.length) next.unchecked = { ...s.unchecked, [ev.stepId]: ev.unchecked };
      if (ev.passedBy || ev.reply) next.passes = { ...s.passes, [ev.stepId]: { passedBy: ev.passedBy, why: ev.why, reply: ev.reply } };
      if (state === 'failed') {
        if (ev.reason) next.reasons = { ...s.reasons, [ev.stepId]: ev.reason };
        // A loop or card fails after its child: the child is the one to show.
        next.failedId ??= ev.stepId;
        if (!s.failedId) next.currentId = ev.stepId;
      }
      return next;
    }
    case 'ended': {
      const ev = a.ev;
      if (ev.runId !== s.runId) return s;
      const states = { ...s.states };
      const reasons = { ...s.reasons };
      const passes = { ...s.passes };
      for (const r of ev.steps) {
        states[r.stepId] = FROM_RESULT[r.result];
        if (r.passedBy || r.reply) passes[r.stepId] = { passedBy: r.passedBy, why: r.why, reply: r.reply };
        if (r.reason) reasons[r.stepId] = r.reason;
      }
      for (const id of s.ids) {
        const st = states[id];
        if (st === 'waiting' || st === 'running' || st === 'looking') states[id] = ev.result === 'pass' ? 'passed' : 'notRun';
      }
      const failedId = s.failedId ?? ev.steps.filter(r => r.result === 'failed').pop()?.stepId;
      return {
        ...s, phase: 'ended', states, reasons, passes, failedId, currentId: undefined, result: ev.result, durationMs: ev.durationMs,
        steps: ev.steps.map(r => (s.screenshots[r.stepId] && !r.screenshotPath ? { ...r, screenshotPath: s.screenshots[r.stepId] } : r)),
      };
    }
  }
}

/** Status word on a row. A stopped run shows the step it stopped at as not run. */
export function rowStatus(state: StepState | undefined, reason?: FailReason): RowStatus | undefined {
  if (!state) return undefined;
  if (state === 'failed' && reason === 'stopped') return 'notRun';
  return state;
}

export interface Tally { passed: number; fixed: number; failed: number }

/** Passed / fixed / failed over the rows shown (a loop row is only a frame, so it doesn't count). */
export function tally(states: Record<string, StepState>, rows: Step[], reasons: Record<string, FailReason> = {}): Tally {
  const t: Tally = { passed: 0, fixed: 0, failed: 0 };
  for (const s of rows) {
    if (s.action === 'loop') continue;
    const st = states[s.id];
    if (st === 'passed') t.passed++;
    else if (st === 'fixed') t.fixed++;
    else if (st === 'failed' && reasons[s.id] !== 'stopped') t.failed++;
  }
  return t;
}

/** Share of rows done, 0..1, for the hairline. */
export function progress(states: Record<string, StepState>, rows: Step[]): number {
  if (!rows.length) return 0;
  const done = rows.filter(s => ['passed', 'fixed', 'failed', 'notRun'].includes(states[s.id] ?? '')).length;
  const stoppedAt = rows.findIndex(s => states[s.id] === 'failed');
  return stoppedAt >= 0 ? (stoppedAt + 1) / rows.length : done / rows.length;
}

/** "Passed" · "Passed with fixes" · "Failed" for a finished run. */
export function overall(result: 'pass' | 'fail', healed: number): 'passed' | 'passedWithFixes' | 'failed' {
  return result === 'fail' ? 'failed' : healed ? 'passedWithFixes' : 'passed';
}

/**
 * The step a report opens on: the failed one, else the first fixed one. `flat` is every step in
 * run order. A run stops at its first failure, so the last failed entry is the step itself and
 * the ones before it are the loops or shared-steps cards around it.
 */
export function focusStep(run: Pick<Run, 'steps'>, flat: Step[]): StepRun | undefined {
  const failed = run.steps.filter(r => r.result === 'failed');
  if (failed.length) return failed[failed.length - 1];
  const isFrame = (id: string) => { const s = flat.find(x => x.id === id); return !!s && (s.action === 'loop' || s.action === 'group') && !!s.steps?.length; };
  return run.steps.find(r => r.result === 'healed' && !isFrame(r.stepId)) ?? run.steps.find(r => r.result === 'healed');
}

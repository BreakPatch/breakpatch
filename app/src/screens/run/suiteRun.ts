// Running a suite by hand on this Mac: its tests one after another through the same run
// machinery as a single test. Pure sequencing; the screen drives it with useTestRun.
import type { App, Suite, SuiteResult, SuiteRun, Test } from '../../data/types';

export type SuiteTestState = 'waiting' | 'running' | 'passed' | 'fixed' | 'failed' | 'notRun' | 'missing';

export interface SuiteItem {
  appId: string;
  testId: string;
  name: string;
  appName: string;
  state: SuiteTestState;
  /** The saved run, for "See report". */
  runId?: string;
  /** Second line: why it failed or couldn't run, or that it passed on a retry. */
  note?: string;
  /** How many retries its run took (engine "Retries"); a test that passed with any passed only on a retry. */
  retried?: number;
}

export interface SuiteRunView {
  phase: 'idle' | 'running' | 'ended';
  items: SuiteItem[];
  /** The test running now, or -1. */
  index: number;
  stopped: boolean;
  startedAt?: number;
  finishedAt?: number;
}

export type SuiteAction =
  | { type: 'plan'; items: SuiteItem[] }
  | { type: 'begin'; at: number }
  | { type: 'testStart'; index: number }
  | { type: 'testEnd'; index: number; state: SuiteTestState; runId?: string; note?: string; retried?: number }
  | { type: 'stop' }
  | { type: 'end'; at: number };

export const INITIAL_SUITE: SuiteRunView = { phase: 'idle', items: [], index: -1, stopped: false };

/** The suite's tests in its order; tests that no longer exist are marked and skipped. */
export function planSuite(suite: Pick<Suite, 'tests'>, find: (appId: string, testId: string) => Test | undefined, apps: App[]): SuiteItem[] {
  return suite.tests.map(r => {
    const t = find(r.appId, r.testId);
    return {
      appId: r.appId, testId: r.testId, name: t?.name ?? 'Test no longer exists',
      appName: apps.find(a => a.id === r.appId)?.name ?? r.appId, state: t ? 'waiting' : 'missing',
      ...(t ? {} : { note: "Couldn't run: it was deleted" }),
    };
  });
}

export function suiteReducer(s: SuiteRunView, a: SuiteAction): SuiteRunView {
  const set = (i: number, patch: Partial<SuiteItem>) => s.items.map((it, k) => (k === i ? { ...it, ...patch } : it));
  switch (a.type) {
    case 'plan': return { ...INITIAL_SUITE, items: a.items };
    case 'begin':
      return { ...s, phase: 'running', stopped: false, index: -1, startedAt: a.at, finishedAt: undefined,
        items: s.items.map(it => (it.state === 'missing' ? it : { ...it, state: 'waiting', runId: undefined, note: undefined, retried: undefined })) };
    case 'testStart': return s.phase === 'running' ? { ...s, index: a.index, items: set(a.index, { state: 'running' }) } : s;
    case 'testEnd': return { ...s, items: set(a.index, { state: a.state, runId: a.runId, note: a.note, retried: a.retried || undefined }) };
    case 'stop': return s.phase === 'running' ? { ...s, stopped: true } : s;
    case 'end':
      return { ...s, phase: 'ended', index: -1, finishedAt: a.at,
        items: s.items.map(it => (it.state === 'waiting' || it.state === 'running' ? { ...it, state: 'notRun' } : it)) };
  }
}

/** The next test to run, or -1 when the suite is done (or was stopped). */
export function nextIndex(s: SuiteRunView): number {
  if (s.phase !== 'running' || s.stopped) return -1;
  return s.items.findIndex((it, i) => i > s.index && it.state === 'waiting');
}

/** A finished test run as a row state. */
export function testOutcome(result: 'pass' | 'fail', healedCount: number): SuiteTestState {
  return result === 'fail' ? 'failed' : healedCount ? 'fixed' : 'passed';
}

/**
 * `flaky` (only when there are some): the tests that passed (or were fixed) only on a retry. They
 * count as passed too, so the suite's result doesn't change: the count says it.
 */
export function suiteCounts(items: SuiteItem[]): SuiteRun['counts'] {
  const n = (st: SuiteTestState) => items.filter(i => i.state === st).length;
  const passed = n('passed'), fixed = n('fixed'), failed = n('failed') + n('missing');
  const flaky = items.filter(i => (i.state === 'passed' || i.state === 'fixed') && i.retried).length;
  return { total: items.length, passed, fixed, failed, notRun: items.length - passed - fixed - failed, ...(flaky ? { flaky } : {}) };
}

/** Failed if any test failed or couldn't run; not run tests (stopped) count as failed too. */
export function suiteResult(c: SuiteRun['counts']): SuiteResult {
  return c.failed || c.notRun ? 'failed' : c.fixed ? 'passed_with_fixes' : 'passed';
}

/** "3 of 6" so far: tests that ran or couldn't run (not the ones a stop skipped). */
export function doneCount(items: SuiteItem[]): number {
  return items.filter(i => !['waiting', 'running', 'notRun'].includes(i.state)).length;
}

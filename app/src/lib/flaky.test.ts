import { describe, expect, it } from 'vitest';
import type { Run, StepRun, Test } from '../data/types';
import { FLAKY_WINDOW, flakinessByTest, flakinessOf, flakyWord, markOf } from './flaky';

const test: Pick<Test, 'id' | 'currentVersion' | 'flakyMark'> = { id: 't1', currentVersion: 3 };
let at = 0;
function run(result: 'pass' | 'fail', o: { version?: number; attempts?: number; reason?: StepRun['reason']; testId?: string; step?: string; retriedAt?: string } = {}): Run {
  at += 1000;
  const steps: StepRun[] = result === 'fail'
    ? [{ stepId: 's1', result: 'passed' }, { stepId: o.step ?? 's2', result: 'failed', reason: o.reason ?? 'timeout' }]
    : [{ stepId: 's1', result: 'passed' }, { stepId: 's2', result: 'passed', ...(o.attempts ? { retried: [{ attempt: 1, reason: 'timeout' as const }] } : {}) }];
  return {
    id: `r${at}`, appId: 'a', testId: o.testId ?? 't1', testName: 'Log in', testVersion: o.version ?? 3, startedBy: { serviceAccount: 'Runner' },
    machine: 'Mac', source: 'runner', startedAt: at, durationMs: 1000, result, healedCount: 0, steps, ...(o.attempts ? { attempts: o.attempts } : {}),
  };
}
/** Runs from a string, oldest first: p pass, f fail, r passed on a retry. */
const history = (s: string, o: Parameters<typeof run>[1] = {}) => [...s].map(c => (c === 'f' ? run('fail', o) : run('pass', { ...o, ...(c === 'r' ? { attempts: 2 } : {}) })));

describe('flaky tests', () => {
  it('a test that only passes is not flaky', () => {
    const f = flakinessOf(test, history('pppppp'));
    expect(f).toMatchObject({ flaky: false, runs: 6, passed: 6, failed: 0, flips: 0, why: '' });
  });

  it('a test that passed and now fails is a real failure, not flaky', () => {
    expect(flakinessOf(test, history('pppppf')).flaky).toBe(false);
    expect(flakinessOf(test, history('ffffpp')).flaky).toBe(false);          // fixed: one change
  });

  it('a failure between passes on the same version is flaky, and says why', () => {
    const f = flakinessOf(test, history('ppfpppfp'));
    expect(f).toMatchObject({ flaky: true, known: false, failed: 2, passed: 6, flips: 4 });
    expect(f.why).toBe('It failed twice and passed 6 times in its last 8 runs of version 3, back and forth, with no change to the test.');
    expect(f.steps).toEqual([{ stepId: 's2', count: 2 }]);
  });

  it('a pass only on a retry is flaky, even once and even in a tests folder with only the last run', () => {
    const f = flakinessOf(test, history('r'));
    expect(f).toMatchObject({ flaky: true, retried: 1, runs: 1 });
    expect(f.why).toBe('It passed only on a retry once in its last run.');
    expect(f.steps).toEqual([{ stepId: 's2', count: 1 }]);
  });

  it('only the current version counts: a new version starts again', () => {
    const old = history('pfpfpf', { version: 2 });
    expect(flakinessOf(test, [...old, ...history('ppp')]).flaky).toBe(false);
    expect(flakinessOf({ ...test, currentVersion: 2 }, old).flaky).toBe(true);
  });

  it("only this test's runs, and only the newest FLAKY_WINDOW", () => {
    const others = history('pfpfpf', { testId: 't2' });
    expect(flakinessOf(test, [...others, ...history('pppp')]).flaky).toBe(false);
    const f = flakinessOf(test, [...history('pfpf'), ...history('p'.repeat(FLAKY_WINDOW))]);
    expect(f.runs).toBe(FLAKY_WINDOW);
    expect(f.flaky).toBe(false);
  });

  it("failures that aren't about the test don't count", () => {
    for (const reason of ['secretMissing', 'setUpFailed', 'stopped', 'healingUnavailable', 'fileMissing'] as const) {
      const runs = [run('pass'), run('fail', { reason }), run('pass'), run('fail', { reason }), run('pass')];
      expect(flakinessOf(test, runs).flaky).toBe(false);
    }
    const real = [run('pass'), run('fail', { reason: 'unexpectedScreen' }), run('pass')];
    expect(flakinessOf(test, real).flaky).toBe(true);
  });

  it('known flaky stays shown, quieter, for that version only', () => {
    const mark = { state: 'known' as const, version: 3, by: 'Maria Lopez', at: 0 };
    const f = flakinessOf({ ...test, flakyMark: mark }, history('pp'));
    expect(f).toMatchObject({ flaky: true, known: true, why: 'Maria Lopez marked it as known flaky.' });
    expect(flakyWord(f)).toBe('Known flaky');
    expect(flakinessOf({ ...test, currentVersion: 4, flakyMark: mark }, history('pp', { version: 4 })).flaky).toBe(false);
    expect(markOf({ currentVersion: 4, flakyMark: mark })).toBeUndefined();
  });

  it('not flaky sets aside the runs before it; a new flip after it shows the marker again', () => {
    const before = history('pfpfp');
    const mark = { state: 'not' as const, version: 3, by: 'Maria Lopez', at: at };
    expect(flakinessOf({ ...test, flakyMark: mark }, before).flaky).toBe(false);
    expect(flakinessOf({ ...test, flakyMark: mark }, [...before, ...history('pp')]).flaky).toBe(false);
    expect(flakinessOf({ ...test, flakyMark: mark }, [...before, ...history('pfp')]).flaky).toBe(true);
  });

  it('by test, from an app\'s runs in any order', () => {
    const runs = [...history('pfp'), ...history('pp', { testId: 't2' })].reverse();
    const m = flakinessByTest([test, { id: 't2', currentVersion: 3 }, { id: 't3', currentVersion: 1 }], runs);
    expect(m.get('t1')?.flaky).toBe(true);
    expect(m.get('t2')?.flaky).toBe(false);
    expect(m.get('t3')).toMatchObject({ flaky: false, runs: 0 });
  });
});

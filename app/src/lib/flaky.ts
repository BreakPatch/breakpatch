// Flaky tests (roadmap #14): a test that both passed and failed on the same version of it, with
// nothing in the test changed, or that passed only on a retry. Worked out from the runs the
// workspace or tests folder keeps: a Team workspace's run history (the last FLAKY_WINDOW runs of
// the test's current version), or a tests folder's last run (which can only show a pass on a
// retry). A new version of the test starts again. Someone can answer the marker (Test.flakyMark):
// "known flaky" keeps it, quieter; "not flaky" sets aside the runs before it.
import type { FailReason, FlakyMark, Run, Test } from '../data/types';
import { attemptsOf } from './runWords';

/** How many of a test's latest runs of its version are looked at. */
export const FLAKY_WINDOW = 20;
/** How many of an app's latest runs a list reads to find each test's (the workspace keeps 300 at hand). */
export const FLAKY_SCAN = 300;

/**
 * Failures that say nothing about the test being flaky: something on this Mac or in the set-up
 * (a saved secret, the set-up call, the AI assistant, a missing file), or someone stopped it.
 */
const NOT_ABOUT_THE_TEST: (FailReason | undefined)[] = ['secretMissing', 'setUpFailed', 'stopped', 'healingUnavailable', 'fileMissing'];

export interface Flakiness {
  /** Show the Flaky marker: it flipped between pass and fail, or passed only on a retry, or someone said it's known flaky. */
  flaky: boolean;
  /** Someone marked it known flaky, for this version. */
  known: boolean;
  /** Why, in plain words. '' when it isn't flaky. */
  why: string;
  /** The runs looked at, and what they did. */
  runs: number; passed: number; failed: number; retried: number; flips: number;
  /** Where its failures were (the earlier tries' too), most often first: step id and how often. */
  steps: { stepId: string; count: number }[];
}

type Outcome = 'pass' | 'retried' | 'fail';

function outcomeOf(r: Run): Outcome | null {
  if (r.result === 'pass') return attemptsOf(r) > 1 ? 'retried' : 'pass';
  const failed = r.steps.filter(s => s.result === 'failed');
  const reason = failed[failed.length - 1]?.reason;
  return NOT_ABOUT_THE_TEST.includes(reason) ? null : 'fail';
}

/** The mark that applies: given on the test's current version. */
export function markOf(test: Pick<Test, 'currentVersion' | 'flakyMark'>): FlakyMark | undefined {
  const m = test.flakyMark;
  return m && m.version === test.currentVersion && (m.state === 'known' || m.state === 'not') ? m : undefined;
}

/**
 * How flaky a test is, from runs (any order, any tests: only this test's runs of its current
 * version count, at most the newest FLAKY_WINDOW, and with "not flaky" only those after it).
 */
export function flakinessOf(test: Pick<Test, 'id' | 'currentVersion' | 'flakyMark'>, runs: Run[]): Flakiness {
  const mark = markOf(test);
  const mine = runs
    .filter(r => r.testId === test.id && r.testVersion === test.currentVersion && !(mark?.state === 'not' && r.startedAt <= mark.at))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, FLAKY_WINDOW);
  const looked = mine.map(r => ({ r, o: outcomeOf(r) })).filter((x): x is { r: Run; o: Outcome } => x.o !== null).reverse();   // oldest first
  let flips = 0;
  for (let i = 1; i < looked.length; i++) if ((looked[i].o === 'fail') !== (looked[i - 1].o === 'fail')) flips++;
  const passed = looked.filter(x => x.o !== 'fail').length;
  const failed = looked.length - passed;
  const retried = looked.filter(x => x.o === 'retried').length;
  const where = new Map<string, number>();
  for (const { r } of looked) for (const s of r.steps) {
    const times = (s.result === 'failed' && r.result === 'fail' && s === r.steps.filter(x => x.result === 'failed').pop() ? 1 : 0) + (s.retried?.length ?? 0);
    if (times) where.set(s.stepId, (where.get(s.stepId) ?? 0) + times);
  }
  // A fail between passes (or a pass between fails) on the same version: flips twice. One flip is a
  // change: a test that passed and now fails is a real failure until it passes again by itself.
  const flipped = flips >= 2;
  const known = mark?.state === 'known';
  const n = looked.length;
  const parts: string[] = [];
  if (flipped) parts.push(`It failed ${times(failed)} and passed ${times(passed)} in its last ${plural(n, 'run')} of version ${test.currentVersion}, back and forth, with no change to the test.`);
  if (retried) parts.push(`It passed only on a retry ${times(retried)}${flipped ? '' : ` in its last ${n === 1 ? 'run' : plural(n, 'run')}`}.`);
  if (known && mark) parts.push(`${mark.by || 'Someone'} marked it as known flaky.`);
  return {
    flaky: flipped || retried > 0 || known, known, why: parts.join(' '),
    runs: n, passed, failed, retried, flips,
    steps: [...where].map(([stepId, count]) => ({ stepId, count })).sort((a, b) => b.count - a.count),
  };
}

/** Each test's flakiness from an app's runs, by test id. */
export function flakinessByTest(tests: Pick<Test, 'id' | 'currentVersion' | 'flakyMark'>[], runs: Run[]): Map<string, Flakiness> {
  const byTest = new Map<string, Run[]>();
  for (const r of runs) byTest.set(r.testId, [...(byTest.get(r.testId) ?? []), r]);
  return new Map(tests.map(t => [t.id, flakinessOf(t, byTest.get(t.id) ?? [])]));
}

/** The marker's word: "Flaky", or "Known flaky" once someone said so. */
export const flakyWord = (f: Pick<Flakiness, 'known'>) => (f.known ? 'Known flaky' : 'Flaky');

function times(n: number): string { return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`; }
function plural(n: number, one: string): string { return `${n} ${n === 1 ? one : `${one}s`}`; }

import type { Suite } from '../../data/types';

type Ref = Suite['tests'][number];
const key = (r: Ref) => `${r.appId}/${r.testId}`;

/**
 * The suite's tests with two of them swapped in place (`a` and `b`, as the editor lists them), so
 * tests it doesn't list (in Recently deleted, or gone) keep their places. Unchanged when either
 * isn't in the suite.
 */
export function swapTests(picked: Ref[], a: Ref, b: Ref): Ref[] {
  const i = picked.findIndex(r => key(r) === key(a)), j = picked.findIndex(r => key(r) === key(b));
  if (i < 0 || j < 0) return picked;
  const next = [...picked];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

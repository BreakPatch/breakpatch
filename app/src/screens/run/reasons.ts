// Plain words for why a step failed (ui-requirements §5.10). One headline per FailReason,
// used as the step's note, the Run view strip and the report heading, plus a one-line reason.
import type { StepRun, Step } from '../../data/types';



// The words the report repeats (the exported report, breakpatch-ci's view.py) live in lib/runWords.ts.
export { UNCHECKED_NOTE, passNote, reasonAdvice, reasonText, reasonTitle, retriedNote, targetName } from '../../lib/runWords';

/** Whether a step's own checks leave anything to compare (DESK-01: a whole-screen ignore zone). */
export function checksNothing(step: Pick<Step, 'action' | 'pre' | 'post' | 'region' | 'ignore'>, vp = { width: 1440, height: 900 }): boolean {
  const ignore = step.ignore ?? [];
  if (!ignore.length) return false;
  const regions = [step.pre?.region, step.post?.region, step.action === 'checkpoint' || step.action === 'waitUntil' ? step.region : undefined]
    .filter((r): r is NonNullable<typeof r> => !!r);
  if (!regions.length) return false;
  const covered = (r: number[]) => ignore.some(b => b[0] <= r[0] && b[1] <= r[1] && b[2] >= Math.min(r[2], vp.width) && b[3] >= Math.min(r[3], vp.height));
  return regions.every(covered);
}

/** Over this, a step says where its time went. */
export const SLOW_MS = 2000;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * "Took 6.1 s: 5.2 s waiting for the page to finish changing after step 2." for a step that took
 * over SLOW_MS, naming the phase that took longest. `prev` is the number of the step before it.
 */
export function slowNote(t: StepRun['timings'], prev?: number | string): string | undefined {
  if (!t) return undefined;
  const parts: [number, string][] = [
    [t.preMs ?? 0, `waiting for the page to finish changing${prev !== undefined ? ` after step ${prev}` : ''}`],
    [t.actionMs ?? 0, 'doing the step'],
    [t.settleMs ?? 0, t.settled === false ? 'waiting for the page, which never stopped changing' : 'waiting for the page to settle after it'],
    [t.postMs ?? 0, 'waiting for the page to look as it did when recorded'],
  ];
  const total = parts.reduce((a, [ms]) => a + ms, 0);
  if (total <= SLOW_MS) return undefined;
  const [ms, what] = parts.reduce((a, b) => (b[0] > a[0] ? b : a));
  return `Took ${secs(total)}: ${secs(ms)} ${what}.`;
}

// The engine's tolerances (engine/src/breakpatch_engine/config.py) for steps saved without one.
const PRE_TOLERANCE = 6, POST_TOLERANCE = 10, CHECKPOINT_TOLERANCE = 8, RELAXED_EXTRA = 2;
/** A passed check this close to its tolerance (hash bits) is "close to failing" (roadmap #14). */
export const CLOSE_BITS = 2;
export const CLOSE_NOTE = 'Passed, but only just: the screen almost didn\'t match the recording. If this test fails now and then, this step may be why.';

/**
 * A step that passed with a screen check within CLOSE_BITS of what it allows (`relaxed`: the run
 * allowed for another system, which adds its 2 bits). Only the checks judged by how close the
 * screen is: not a step whose result is only that something changed, or that passed another way.
 */
export function closeToFailing(step: Pick<Step, 'action' | 'pre' | 'post' | 'tolerance' | 'expect'>, r: StepRun | undefined, relaxed = false): boolean {
  if (!r || (r.result !== 'passed' && r.result !== 'healed') || r.passedBy) return false;
  const extra = relaxed ? RELAXED_EXTRA : 0;
  const near = (d: number | undefined, tol: number) => typeof d === 'number' && d <= tol + extra && tol + extra - d <= CLOSE_BITS;
  if (step.pre && near(r.preDistance, step.pre.tolerance ?? PRE_TOLERANCE)) return true;
  if (step.expect === 'changes' || step.expect === 'noChange') return false;
  const post = step.action === 'checkpoint' ? step.tolerance ?? CHECKPOINT_TOLERANCE : step.post ? step.post.tolerance ?? POST_TOLERANCE : undefined;
  return post !== undefined && near(r.postDistance, post);
}

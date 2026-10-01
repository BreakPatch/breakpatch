// Plain words for why a step failed (ui-requirements §5.10). One headline per FailReason,
// used as the step's note, the Run view strip and the report heading, plus a one-line reason.
import type { StepRun, Step } from '../../data/types';



// The words the report repeats (the exported report, breakpatch-ci's view.py) live in lib/runWords.ts.
export { UNCHECKED_NOTE, passNote, reasonAdvice, reasonText, reasonTitle, targetName } from '../../lib/runWords';

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





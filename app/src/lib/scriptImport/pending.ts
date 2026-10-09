// An imported script's steps, from the Import dialog to the recorder that learns them (roadmap
// #16). Kept in memory only, for the test just made: the recorder takes them once, when its
// browser is ready. Nothing of the script is saved until the person saves the learned test.
import type { WalkStep } from './walkStep';

export interface PendingImport { steps: WalkStep[]; note?: string }

const pending = new Map<string, PendingImport>();
const key = (appId: string, testId: string) => `${appId}/${testId}`;

/** Hands the steps to the recorder that opens this test next. */
export function holdImport(appId: string, testId: string, p: PendingImport): void { pending.set(key(appId, testId), p); }

/** The steps waiting for this test, once: they're gone after this. */
export function takeImport(appId: string, testId: string): PendingImport | undefined {
  const k = key(appId, testId);
  const p = pending.get(k);
  pending.delete(k);
  return p;
}

/** Whether steps are waiting for this test (the recorder waits for its browser before it takes them). */
export function hasImport(appId: string, testId: string): boolean { return pending.has(key(appId, testId)); }

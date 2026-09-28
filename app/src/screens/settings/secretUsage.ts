// Counts how many tests use each saved secret, from the current versions' steps
// (including loop children and shared steps the test uses).
import type { Backend, Listener, Unsubscribe } from '../../data/backend';
import type { App, Step, StepGroup, Test } from '../../data/types';

export interface TestSteps { key: string; steps: Step[] }

function collect(steps: Step[], groups: Map<string, Step[]>, out: Set<string>, seen: Set<string>) {
  for (const s of steps) {
    if (s.secretRef) out.add(s.secretRef);
    if (s.steps) collect(s.steps, groups, out, seen);
    if (s.groupId && !seen.has(s.groupId)) {
      seen.add(s.groupId);
      collect(groups.get(s.groupId) ?? [], groups, out, seen);
    }
  }
}

/** Secret name → number of tests that type it. */
export function countSecretUsage(tests: TestSteps[], groups: Map<string, Step[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const t of tests) {
    const names = new Set<string>();
    collect(t.steps, groups, names, new Set());
    names.forEach(n => counts.set(n, (counts.get(n) ?? 0) + 1));
  }
  return counts;
}

/** Resolves with the first value a live listener delivers. */
export function first<T>(sub: (l: Listener<T>) => Unsubscribe): Promise<T> {
  return new Promise(resolve => {
    let done = false;
    // The listener may fire synchronously, before `off` is assigned, so unsubscribe on a microtask.
    const off: Unsubscribe = sub(v => { if (done) return; done = true; resolve(v); queueMicrotask(() => off()); });
  });
}

/** Reads every app's tests and shared steps once and counts secret usage. */
export async function loadSecretUsage(b: Backend): Promise<Map<string, number>> {
  const apps = await first<App[]>(l => b.apps(l));
  const tests: TestSteps[] = [];
  const groups = new Map<string, Step[]>();
  await Promise.all(apps.map(async app => {
    const [ts, gs] = await Promise.all([first<Test[]>(l => b.tests(app.id, l)), first<StepGroup[]>(l => b.stepGroups(app.id, l))]);
    await Promise.all([
      ...gs.map(async g => { const v = await b.groupVersion(app.id, g.id, g.currentVersion); if (v) groups.set(g.id, v.steps); }),
      ...ts.map(async t => { const v = await b.version(app.id, t.id, t.currentVersion); if (v) tests.push({ key: `${app.id}/${t.id}`, steps: v.steps }); }),
    ]);
  }));
  return countSecretUsage(tests, groups);
}

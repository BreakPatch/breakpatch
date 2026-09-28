// Counts tests created and runs where they are saved (lib/usage.ts; docs/manual.md "Privacy").
// Every backend the session opens (the tests folder, and in Team the workspace) is wrapped once, so
// whatever saves through it is counted in one place: the recorder and New test, the run view, and
// in Team the local runner and schedules. Only numbers go on; the demo's sample data isn't counted.
import type { Backend } from './backend';
import type { Run } from './types';
import { usage, type RunSource } from '../lib/usage';

type Recorder = Pick<typeof usage, 'testCreated' | 'run'>;

/** Where a saved run came from, for the counts. `trigger: 'schedule'`: the runner ran it for a schedule. */
export function runSourceOf(r: Pick<Run, 'source'>, trigger?: 'schedule'): RunSource {
  if (r.source === 'ci') return 'ci';
  if (r.source === 'runner') return trigger === 'schedule' ? 'schedule' : 'runner';
  return 'manual';
}

/**
 * The same backend, counting createTest, duplicateTest and addRun once each has saved. Everything
 * else passes straight through, bound to the backend itself (its own calls inside aren't counted
 * twice, and `instanceof` still works).
 */
export function countUsage<B extends Backend>(b: B, rec: Recorder = usage): B {
  if (b.kind === 'demo') return b;
  const bound = new Map<PropertyKey, unknown>();
  const counted: Partial<Record<keyof Backend, unknown>> = {
    createTest: async (...a: Parameters<Backend['createTest']>) => { const t = await b.createTest(...a); rec.testCreated(); return t; },
    duplicateTest: async (...a: Parameters<Backend['duplicateTest']>) => { const t = await b.duplicateTest(...a); rec.testCreated(); return t; },
    addRun: async (...a: Parameters<Backend['addRun']>) => {
      const saved = await b.addRun(...a);
      rec.run(runSourceOf(a[0], a[1]?.trigger), a[0].result === 'pass' ? 'pass' : 'fail');
      return saved;
    },
  };
  return new Proxy(b, {
    get(target, prop) {
      if (Object.prototype.hasOwnProperty.call(counted, prop)) return counted[prop as keyof Backend];
      const v = Reflect.get(target, prop, target);
      if (typeof v !== 'function') return v;
      if (!bound.has(prop)) bound.set(prop, (v as (...x: unknown[]) => unknown).bind(target));
      return bound.get(prop);
    },
  });
}

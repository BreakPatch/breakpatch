// Pure filtering for the Tests and Runs tabs.
import type { Run, Test } from '../../data/types';
import { lastRunStatus, runBy, runStatus } from '../../components/common';

export type SharedFilter = 'all' | 'published' | 'draft';
export type LastRunFilter = 'all' | 'passed' | 'fixed' | 'failed' | 'never';
export interface TestFilters { q: string; shared: SharedFilter; lastRun: LastRunFilter; createdBy: string /* uid or 'all' */ }

export function filterTests(tests: Test[], f: TestFilters): Test[] {
  const q = f.q.trim().toLowerCase();
  return tests.filter(t =>
    (!q || t.name.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q)) &&
    (f.shared === 'all' || t.status === f.shared) &&
    (f.lastRun === 'all' || lastRunStatus(t.lastRun) === f.lastRun) &&
    (f.createdBy === 'all' || t.createdBy.uid === f.createdBy));
}

export type ResultFilter = 'all' | 'passed' | 'passedWithFixes' | 'failed';
export interface RunFilters { testId: string; result: ResultFilter; where: 'all' | Run['source']; who: string }

export function filterRuns(runs: Run[], f: RunFilters): Run[] {
  return runs.filter(r =>
    (f.testId === 'all' || r.testId === f.testId) &&
    (f.result === 'all' || runStatus(r) === f.result) &&
    (f.where === 'all' || r.source === f.where) &&
    (f.who === 'all' || runBy(r) === f.who));
}

/** Distinct values in first-seen order. */
export function distinct<T, K>(items: T[], key: (t: T) => K): T[] {
  const seen = new Set<K>(); const out: T[] = [];
  for (const it of items) { const k = key(it); if (!seen.has(k)) { seen.add(k); out.push(it); } }
  return out;
}

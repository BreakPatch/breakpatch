// Plain words for run fields, shared by lists, reports and suites.
import type { Run, RunSummary } from '../../data/types';
import type { Status } from '../ui';

// WHERE and runBy are the report's words too (lib/runWords.ts).
export { WHERE, runBy } from '../../lib/runWords';


/** A whole run: Passed, Passed with fixes, Failed. */
export function runStatus(r: Pick<Run, 'result' | 'healedCount'>): Status {
  return r.result === 'fail' ? 'failed' : r.healedCount > 0 ? 'passedWithFixes' : 'passed';
}

/** A test's last run in a table: Passed, Fixed automatically, Failed, Never run. */
export function lastRunStatus(s: RunSummary | undefined): Status {
  return !s ? 'never' : s.result === 'fail' ? 'failed' : s.result === 'healed' ? 'fixed' : 'passed';
}

// Plain words for run fields, shared by lists, reports and suites.
import type { Run, RunSource, RunSummary } from '../../data/types';
import type { Status } from '../ui';

export const WHERE: Record<RunSource, { label: string; icon: string }> = {
  desktop: { label: 'This Mac', icon: 'laptop_mac' },
  ci: { label: 'CI', icon: 'cloud' },
  runner: { label: 'Local runner', icon: 'dns' },
};

/** Who started a run: a person's name or the service account ("Nightly suite"). */
export function runBy(r: Pick<Run, 'startedBy'>): string {
  return 'name' in r.startedBy ? r.startedBy.name : r.startedBy.serviceAccount;
}

/** A whole run: Passed, Passed with fixes, Failed. */
export function runStatus(r: Pick<Run, 'result' | 'healedCount'>): Status {
  return r.result === 'fail' ? 'failed' : r.healedCount > 0 ? 'passedWithFixes' : 'passed';
}

/** A test's last run in a table: Passed, Fixed automatically, Failed, Never run. */
export function lastRunStatus(s: RunSummary | undefined): Status {
  return !s ? 'never' : s.result === 'fail' ? 'failed' : s.result === 'healed' ? 'fixed' : 'passed';
}

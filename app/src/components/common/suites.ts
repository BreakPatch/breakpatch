// Plain-language pieces for suites, shared by the Suites list and (in Team) the runner screens.
import type { App, Suite, SuiteResult } from '../../data/types';
import type { Status } from '../ui';
import { plural } from './format';

export function suiteResultStatus(r: SuiteResult): Status {
  return r === 'passed' ? 'passed' : r === 'passed_with_fixes' ? 'passedWithFixes' : r === 'failed' ? 'failed' : 'replaced';
}

/** "3 tests · Web app, Console", or "5 tests · 3 apps". */
export function testsLine(suite: Pick<Suite, 'tests'>, apps: App[] | undefined): string {
  if (!suite.tests.length) return 'No tests';
  const ids = [...new Set(suite.tests.map(t => t.appId))];
  const names = ids.map(id => apps?.find(a => a.id === id)?.name ?? id);
  return `${plural(suite.tests.length, 'test')} · ${ids.length > 2 ? `${ids.length} apps` : names.join(', ')}`;
}

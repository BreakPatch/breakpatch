// The report's run: the live list's copy, with the issue and explanations another Mac added later
// taken from the run read by id (a workspace's cached lists don't hear about those).
import { describe, expect, it } from 'vitest';
import type { Run } from '../../data/types';
import { withLaterFields } from './useReport';

const base: Run = {
  id: 'r1', appId: 'web', testId: 't1', testName: 'Log in', testVersion: 2, startedBy: { uid: 'u', name: 'Ana', email: 'ana@acme.example' },
  machine: 'Mac', source: 'desktop', startedAt: 1, durationMs: 1, result: 'fail', healedCount: 0,
  steps: [{ stepId: 's1', result: 'passed' }, { stepId: 's2', result: 'failed', reason: 'targetNotFound' }],
};
const why = { summary: 'The Save button now reads “Save changes”.', cause: 'textChanged', suggestion: 'acceptChange' } as const;

describe('the run the report shows', () => {
  it('is the list\'s, or the one read by id when the list has none', () => {
    expect(withLaterFields(base, undefined)).toBe(base);
    expect(withLaterFields(undefined, base)).toBe(base);
    expect(withLaterFields(undefined, null)).toBeNull();
    expect(withLaterFields(base, { ...base })).toBe(base);                    // nothing added later
  });

  it('takes the issue and a failed step\'s explanation from the run read by id', () => {
    const issue = { provider: 'github' as const, key: 'acme/web#1', url: 'https://github.com/acme/web/issues/1' };
    const later: Run = { ...base, issue, steps: [base.steps[0], { ...base.steps[1], explanation: why }] };
    const run = withLaterFields(base, later)!;
    expect(run.issue).toEqual(issue);
    expect(run.steps[1].explanation).toEqual(why);
    expect(run.steps[0]).toBe(base.steps[0]);
  });

  it('keeps what the list has, and ignores another run', () => {
    const mine: Run = { ...base, issue: { provider: 'linear', key: 'WEB-1', url: 'https://linear.app/x/WEB-1' } };
    expect(withLaterFields(mine, { ...base, issue: { provider: 'jira', key: 'W-2', url: 'https://acme.atlassian.net/W-2' } })!.issue?.key).toBe('WEB-1');
    expect(withLaterFields(base, { ...base, id: 'r2', issue: mine.issue })).toBe(base);
  });
});

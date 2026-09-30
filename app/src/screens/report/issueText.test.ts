import { describe, expect, it } from 'vitest';
import type { FailReason, Run, Step, StepRun } from '../../data/types';
import { expectedText, explanationIn, issueContent, issueTitle, mdText, stepsUpTo } from './issueText';

const done: Step = { id: 's5', action: 'click', label: 'Click Done', target: 'Done button, bottom right' };
const steps: Step[] = [
  { id: 's1', action: 'navigate', label: 'Open the projects page', url: 'https://app.example.com/projects' },
  { id: 'g', action: 'group', label: 'Sign in', groupId: 'sign-in', steps: [
    { id: 'g1', action: 'write', label: 'Write the email', target: 'Email field' },
    { id: 'g2', action: 'click', label: 'Click Next', target: 'Next button' },
  ] },
  { id: 'l', action: 'loop', label: 'Add 2 rows', count: 2, steps: [{ id: 'l1', action: 'click', label: 'Click Add row' }] },
  { id: 's4', action: 'write', label: 'Write the name' },
  done,
  { id: 's6', action: 'click', label: 'Click Close' },
];
const run: Run = {
  id: 'rn-l8x2k-0', appId: 'web', testId: 'create-project', testName: 'Create a project', testVersion: 7,
  startedBy: { serviceAccount: 'Local runner' }, machine: 'QA Mac mini', source: 'runner', startedAt: Date.UTC(2026, 8, 24, 14, 10),
  durationMs: 12_000, result: 'fail', healedCount: 0, steps: [],
};
const failed = (reason: FailReason, extra: Partial<StepRun> = {}): StepRun => ({ stepId: 's5', result: 'failed', reason, ...extra });
const content = (r: StepRun, over: Partial<Parameters<typeof issueContent>[0]> = {}) =>
  issueContent({ run, test: undefined, steps, step: done, stepRun: r, number: '6', appName: 'Web app', ...over });

describe('the issue for a failed step', () => {
  it('has a title that says which step failed and why', () => {
    expect(issueTitle(run, done, '6', failed('targetNotFound'))).toBe("Create a project: step 6 Click Done failed: couldn't find the Done button");
    expect(issueTitle(run, done, '6', failed('timeout'))).toBe('Create a project: step 6 Click Done failed: waited too long for the page');
  });

  it('writes up every reason in plain words', () => {
    const reasons: FailReason[] = ['targetNotFound', 'unexpectedScreen', 'noChange', 'timeout', 'healFailed', 'healingUnavailable', 'secretMissing', 'setUpFailed', 'fileMissing'];
    for (const reason of reasons) {
      const c = content(failed(reason));
      expect(c.title, reason).not.toMatch(/undefined|This step failed/);
      expect(c.markdown, reason).toContain('### Expected');
      expect(c.markdown, reason).toContain('### Seen');
      expect(c.markdown, reason).not.toContain('undefined');
    }
  });

  it('lists the steps up to the failure, with loops and shared steps numbered as in the app', () => {
    expect(stepsUpTo(steps, 's5')).toEqual([
      { number: '1', label: 'Open the projects page' }, { number: '2', label: 'Sign in' }, { number: '2.1', label: 'Write the email' },
      { number: '2.2', label: 'Click Next' }, { number: '3', label: 'Add 2 rows' }, { number: '4', label: 'Click Add row' },
      { number: '5', label: 'Write the name' }, { number: '6', label: 'Click Done' },
    ]);
    const md = content(failed('targetNotFound')).markdown;
    expect(md).toContain('6. Click Done ← failed here');
    expect(md).not.toContain('Click Close');
    // A step inside shared steps.
    const inner = issueContent({ run, test: undefined, steps, step: steps[1].steps![1], stepRun: { stepId: 'g2', result: 'failed', reason: 'targetNotFound' }, number: '2.2', appName: 'Web app' });
    expect(inner.title).toBe("Create a project: step 2.2 Click Next failed: couldn't find the Next button");
    expect(inner.markdown).toContain('2.2. Click Next ← failed here');
    expect(inner.markdown).not.toContain('Add 2 rows');
    // A step inside a loop.
    const looped = issueContent({ run, test: undefined, steps, step: steps[2].steps![0], stepRun: { stepId: 'l1', result: 'failed', reason: 'noChange' }, number: '4', appName: 'Web app' });
    expect(looped.markdown).toContain('3. Add 2 rows\n4. Click Add row ← failed here');
  });

  it('says where and when it ran, and links the report', () => {
    const md = content(failed('targetNotFound'), { test: { startUrl: 'https://app.example.com/projects' } as never, reportUrl: 'https://breakpatch.dev/report#r=web/rn-l8x2k-0' }).markdown;
    expect(md).toContain('- App: Web app');
    expect(md).toContain('- Start address: https://app.example.com/projects');
    expect(md).toContain('- Test: Create a project, version 7');
    expect(md).toContain('- Run by: Local runner, the local runner (Local runner), on QA Mac mini');
    expect(md).toContain('- Run ID: rn-l8x2k-0');
    expect(md).toContain('[Open the report in Breakpatch](https://breakpatch.dev/report#r=web/rn-l8x2k-0)');
  });

  it('puts in the picture, or the local path only when that is wanted', () => {
    const r = failed('targetNotFound', { screenshotPath: '/Users/ana/Library/shot.png' });
    expect(content(r).markdown).toContain('Screenshot: `/Users/ana/Library/shot.png`');
    expect(content(r, { noLocalPaths: true }).markdown).not.toContain('/Users/');
    expect(content(r, { imageUrl: 'https://x/shot.png' }).markdown).toContain('![Screenshot of step 6](https://x/shot.png)');
  });

  it("adds the AI assistant's explanation when there is one (#7)", () => {
    const md = content(failed('targetNotFound', { explanation: { summary: 'The Done button moved into a menu.', cause: 'A redesign', suggestion: 'Re-record step 6' } } as Partial<StepRun>)).markdown;
    expect(md).toContain('**The AI assistant says:** The Done button moved into a menu.');
    expect(md).toContain('- Cause: A redesign');
    expect(md).toContain('- Try: Re-record step 6');
    expect(content(failed('targetNotFound')).markdown).not.toContain('AI assistant says');
    expect(explanationIn(undefined, { explanation: { summary: 'On the run' } })).toEqual({ summary: 'On the run' });
  });

  it('writes Markdown characters in labels as text, and says what was expected', () => {
    expect(mdText('Click *New* [beta]')).toBe('Click \\*New\\* \\[beta\\]');
    expect(expectedText(done)).toBe('The Done button is where it was when the step was recorded, and the page afterwards looks as it did then.');
    expect(expectedText({ ...done, expect: 'closes' })).toBe('What was open closes.');
    expect(expectedText({ ...done, expectNote: 'The dialog closes and the project is listed' })).toBe('The dialog closes and the project is listed');
  });
});

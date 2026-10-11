import { describe, expect, it } from 'vitest';
import type { FailReason, Step } from '../../data/types';
import { closeToFailing, reasonAdvice, reasonText, reasonTitle, targetName } from './reasons';

const done: Step = { id: 's6', action: 'click', label: 'Click Done', target: 'Done button, bottom right of the Create project dialog', at: [920, 634] };

describe('reason texts', () => {
  it('names the target in plain words', () => {
    expect(targetName(done)).toBe('the Done button');
    expect(targetName({ action: 'click', label: 'x', target: 'The spot you clicked' })).toBe('what to click');
    expect(targetName({ action: 'write', label: 'x' })).toBe('the field to write in');
  });
  it('uses the ui-requirements wording', () => {
    expect(reasonTitle('targetNotFound', done)).toBe("Couldn't find the Done button");
    expect(reasonTitle('unexpectedScreen', done)).toBe("The screen didn't look as expected after this step");
    expect(reasonTitle('noChange', done)).toBe('Nothing happened after this step');
    expect(reasonTitle('timeout', done)).toBe('Waited too long for the page');
    expect(reasonTitle('healingUnavailable', done)).toBe("The AI assistant isn't downloaded, so this couldn't be fixed automatically");
    expect(reasonTitle('secretMissing', done)).toBe('Saved secret is missing on this Mac');
  });
  it('has a headline, a reason and advice for every FailReason', () => {
    const all: FailReason[] = ['targetNotFound', 'unexpectedScreen', 'noChange', 'timeout', 'healFailed', 'healingUnavailable', 'secretMissing', 'setUpFailed', 'stopped'];
    for (const r of all) {
      expect(reasonTitle(r, done)).not.toBe('This step failed');
      expect(reasonText(r, done).length).toBeGreaterThan(10);
      expect(reasonAdvice(r).length).toBeGreaterThan(10);
    }
  });
  it('names the missing secret', () => {
    expect(reasonText('secretMissing', { action: 'write', label: 'x', secretRef: 'ACME_TEST_EMAIL' })).toContain('ACME_TEST_EMAIL');
  });
});

describe('close to failing (roadmap #14)', () => {
  const click = { action: 'click' as const, pre: { region: [0, 0, 1, 1] as [number, number, number, number], hash: 'x', tolerance: 6 }, post: { region: [0, 0, 1, 1] as [number, number, number, number], hash: 'x', tolerance: 10 } };
  it('a check within 2 bits of its tolerance is close; further in, or a failure, is not', () => {
    expect(closeToFailing(click, { stepId: 's', result: 'passed', preDistance: 4 })).toBe(true);
    expect(closeToFailing(click, { stepId: 's', result: 'passed', preDistance: 3, postDistance: 10 })).toBe(true);
    expect(closeToFailing(click, { stepId: 's', result: 'passed', preDistance: 3, postDistance: 7 })).toBe(false);
    expect(closeToFailing(click, { stepId: 's', result: 'failed', preDistance: 6 })).toBe(false);
    expect(closeToFailing(click, { stepId: 's', result: 'passed', postDistance: 10, passedBy: 'gone' })).toBe(false);
  });
  it('relaxed checks and a checkpoint\'s own tolerance', () => {
    expect(closeToFailing(click, { stepId: 's', result: 'passed', preDistance: 4 }, true)).toBe(false);
    expect(closeToFailing(click, { stepId: 's', result: 'passed', preDistance: 7 }, true)).toBe(true);
    expect(closeToFailing({ action: 'checkpoint', tolerance: 8 }, { stepId: 's', result: 'passed', postDistance: 7 })).toBe(true);
    expect(closeToFailing({ ...click, expect: 'changes' }, { stepId: 's', result: 'passed', preDistance: 0, postDistance: 10 })).toBe(false);
  });
});

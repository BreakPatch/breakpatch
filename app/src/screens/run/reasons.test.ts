import { describe, expect, it } from 'vitest';
import type { FailReason, Step } from '../../data/types';
import { reasonAdvice, reasonText, reasonTitle, targetName } from './reasons';

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

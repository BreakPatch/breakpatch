import { describe, expect, it } from 'vitest';
import type { Run, Step } from '../../data/types';
import { copyDetails, detailKind, detailText, fixBoxes, movedStep, showsScreens, tookText } from './reportData';

const done: Step = { id: 's6', action: 'click', label: 'Click Done', target: 'Done button, bottom right', at: [100, 100], pre: { region: [80, 80, 120, 120], hash: 'abc', tolerance: 6 } };

describe('report data', () => {
  it('moves the locked area with Accept new position', () => {
    const m = movedStep(done, [100, 100], [130, 90]);
    expect(m.at).toEqual([130, 90]);
    expect(m.pre).toEqual({ region: [110, 70, 150, 110], hash: 'abc', tolerance: 6 });
    expect(done.at).toEqual([100, 100]);
  });
  it('draws old and new position at the locked area size', () => {
    expect(fixBoxes(done, [100, 100], [200, 200])).toEqual({ old: [80, 80, 120, 120], now: [180, 180, 220, 220] });
  });
  it('says what kind of detail a step gets', () => {
    expect(detailKind({ stepId: 'a', result: 'failed', reason: 'stopped' })).toBe('stopped');
    expect(detailKind({ stepId: 'a', result: 'healed' })).toBe('fixed');
    expect(detailKind(undefined)).toBe('notRun');
    expect(showsScreens({ stepId: 'a', result: 'failed', reason: 'targetNotFound' })).toBe(true);
    expect(showsScreens({ stepId: 'a', result: 'failed', reason: 'secretMissing' })).toBe(false);
  });
  it('only asks to accept when the edition can', () => {
    expect(detailText('fixed', done, undefined, true).body).toContain('Accept');
    expect(detailText('fixed', done, undefined, false).body).not.toContain('Accept');
    expect(detailText('fixed', done, undefined, false).headline).toBe('The Done button had moved. The AI assistant found it.');
  });
  it('says how long a run took', () => {
    expect(tookText(51_000)).toBe('51 s');
    expect(tookText(68_000)).toBe('1 min 8 s');
    expect(tookText(120_000)).toBe('2 min');
  });
  it('copies details for a developer', () => {
    const run = { id: 'run-1', appId: 'web', testId: 't', testName: 'Create a project', testVersion: 7, startedBy: { uid: 'u', name: 'Maria Lopez', email: '' }, machine: "Maria's Mac", source: 'desktop', startedAt: Date.now(), durationMs: 51_000, result: 'fail', healedCount: 0, steps: [] } as Run;
    const text = copyDetails(run, done, '6', { stepId: 's6', result: 'failed', reason: 'targetNotFound' }, 'Web app');
    expect(text).toContain('Step 6: Click Done');
    expect(text).toContain("Couldn't find the Done button (targetNotFound)");
    expect(text).toContain("Maria Lopez · This Mac · Maria's Mac");
  });
});

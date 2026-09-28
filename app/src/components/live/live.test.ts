import { describe, expect, it } from 'vitest';
import type { Step } from '../../data/types';
import { fitScale, gesture, lockBox, nextZoom, normBox, toViewport } from './geometry';
import { applyStep, expandText, hitSample, replay, SAMPLE_INITIAL } from './sample/sampleModel';

const VP = { width: 1440, height: 900 };
const step = (p: Partial<Step> & { action: Step['action'] }): Step => ({ id: 'x', label: 'x', ...p });

describe('geometry', () => {
  it('fits the viewport inside the pane minus padding, never above 100 %', () => {
    expect(fitScale({ width: 900, height: 614 }, VP)).toBeCloseTo(868 / 1440);
    expect(fitScale({ width: 3000, height: 2000 }, VP)).toBe(1);
  });
  it('maps display offsets back to viewport pixels, clamped', () => {
    expect(toViewport({ x: 300, y: 150 }, 0.5, VP)).toEqual([600, 300]);
    expect(toViewport({ x: -5, y: 9999 }, 0.5, VP)).toEqual([0, 899]);
  });
  it('steps through zoom levels', () => {
    expect(nextZoom(0.6, 1)).toBe(0.67);
    expect(nextZoom(0.6, -1)).toBe(0.5);
  });
  it('reads a drag as a direction and distance', () => {
    expect(gesture([100, 500], [110, 200])).toEqual({ direction: 'up', distance: 300 });
    expect(gesture([100, 100], [400, 120])).toEqual({ direction: 'right', distance: 300 });
    expect(normBox([10, 50], [5, 20])).toEqual([5, 20, 10, 50]);
  });
  it('locks a step to its region, its pre-check or its point', () => {
    expect(lockBox(step({ action: 'checkpoint', region: [1, 2, 3, 4] }))).toEqual([1, 2, 3, 4]);
    expect(lockBox(step({ action: 'click', at: [100, 100], pre: { region: [68, 68, 132, 132], hash: 'h', tolerance: 6 } }))).toEqual([68, 68, 132, 132]);
    expect(lockBox(step({ action: 'click', at: [100, 100] }))).toEqual([76, 76, 124, 124]);
    expect(lockBox(step({ action: 'waitFor' }))).toBeNull();
  });
});

describe('sample app', () => {
  it('reacts like the prototype: dialog, typed name, success message', () => {
    let s = applyStep(SAMPLE_INITIAL, step({ action: 'click', at: [1330, 118] }), VP);
    expect(s.dialog).toBe(true);
    expect(hitSample([1330, 118], VP, s)).toBeUndefined();          // New project is behind the dialog
    s = applyStep(s, step({ action: 'click', at: [720, 300] }), VP);
    expect(s.focus).toBe('name');
    s = applyStep(s, step({ action: 'write', text: 'Test project {time}' }), VP, 1, new Date(2026, 8, 24, 14, 52));
    expect(s.name).toBe('Test project 14:52');
    s = applyStep(s, step({ action: 'click', at: [920, 634] }), VP);
    expect(s).toMatchObject({ dialog: false, created: 'Test project 14:52', projects: ['Test project 14:52'] });
  });
  it('repeats loop children with the repeat number', () => {
    const loop = step({ action: 'loop', count: 2, steps: [
      step({ action: 'click', at: [1330, 118] }), step({ action: 'click', at: [720, 300] }),
      step({ action: 'write', text: 'Note {i}' }), step({ action: 'click', at: [920, 634] }),
    ] });
    expect(replay([loop], VP).projects).toEqual(['Note 2', 'Note 1']);
    expect(expandText('{i}-{date}', 3, new Date(2026, 0, 5))).toBe('3-2026-01-05');
  });
});

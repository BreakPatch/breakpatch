// Live browser view, shared by the Recorder, the Run view and the Report.
import type { Step } from '../../data/types';
import { demoEngine } from '../../engine';
import { actionInfo } from '../../engine/labels';
import { inside, lockBox } from './geometry';
import type { LiveMarker } from './LiveView';

export { LiveView, CheckingPill, SavedPill, type LiveMarker, type LiveTool, type LiveViewProps } from './LiveView';
export { sampleApp, useSampleState } from './sample/sampleStore';
export { SampleApp } from './sample/SampleApp';
export { SAMPLE_INITIAL, SAMPLE_PATH, applyStep, replay, type SampleState } from './sample/sampleModel';
export * from './geometry';

const CLICKS = new Set<Step['action']>(['click', 'doubleClick', 'longClick', 'rightClick', 'hover']);

/**
 * The locked-area marker for a step, or null when it has no area on the page. In demo mode
 * a point snaps to the sample app's button under it, and the marker hides while that
 * button isn't on screen (like the prototype). Run view: pass label "Clicking here".
 */
export function stepMarker(step: Step, n: number, label?: string): LiveMarker | null {
  const eng = demoEngine();
  let hidden = false;
  const snap = eng ? (p: [number, number]) => {
    const t = eng.targets.find(x => inside(p, x.box));
    if (t && !t.visible()) hidden = true;
    return t?.box;
  } : undefined;
  const box = lockBox(step, snap);
  if (!box || hidden) return null;
  return { kind: 'locked', box, n, label: label ?? (CLICKS.has(step.action) ? `${actionInfo(step.action).name} locked here` : 'Locked here') };
}

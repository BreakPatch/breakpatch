// Demo mode (`?demo`, simulated engine): reproduces the prototype. "Click Done" in the seeded
// "Create a project" was recorded before the app's redesign, so the run fails there until the
// step is re-recorded (a re-recorded step has a locked area; the seeded one has none).
import type { Box, Step, Viewport } from '../../data/types';
import { demoEngine } from '../../engine';
import { lockBox, type SampleState } from '../../components/live';
import { boxOf, SAMPLE_TARGETS } from '../../components/live/sample/sampleModel';
import { preorder } from './resolve';

export const isDemo = () => demoEngine() !== null;

/** Steps the demo run fails on. */
export function demoFailIds(steps: Step[]): string[] {
  return preorder(steps).filter(s => s.action === 'click' && s.label === 'Click Done' && s.at && !s.pre).map(s => s.id);
}

/** What the sample page showed when a demo run failed, by saved run id (in memory, like screenshots). */
export const demoSeen = new Map<string, SampleState>();

/**
 * The box a step acts on, for "Clicking here" and the report markers. In demo mode a point snaps
 * to the sample app's button under it even while that button isn't on screen.
 */
export function targetBox(step: Step, vp: Pick<Viewport, 'width' | 'height'>): Box | null {
  const snap = isDemo()
    ? (p: [number, number]) => SAMPLE_TARGETS.map(d => boxOf(d, vp)).find(b => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3])
    : undefined;
  return lockBox(step, snap);
}

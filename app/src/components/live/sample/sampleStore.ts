// Live state of the sample app in demo mode. The recorder (and later the run view)
// calls `sampleApp.perform(step)` after the engine records or runs a step, so the page
// reacts like the prototype: New project opens the dialog, written text shows up, Done
// shows the success message.
import { create } from 'zustand';
import type { Step, Viewport } from '../../../data/types';
import { applyStep, replay, SAMPLE_INITIAL, type SampleState } from './sampleModel';

export const useSampleState = create<SampleState>(() => SAMPLE_INITIAL);

const DEFAULT_VP = { width: 1440, height: 900 };

export const sampleApp = {
  get: (): SampleState => useSampleState.getState(),
  /** Back to the start page (a fresh browser at the start address). */
  reset: () => useSampleState.setState(SAMPLE_INITIAL, true),
  /** Applies a recorded or replayed step. `repeat` is the loop iteration (1-based). */
  perform: (step: Step, vp: Pick<Viewport, 'width' | 'height'> = DEFAULT_VP, repeat = 1) =>
    useSampleState.setState(s => applyStep(s, step, vp, repeat), true),
  /** Puts the page in the state after these steps, from a fresh start (re-record). */
  replay: (steps: Step[], vp: Pick<Viewport, 'width' | 'height'> = DEFAULT_VP) =>
    useSampleState.setState(replay(steps, vp), true),
};

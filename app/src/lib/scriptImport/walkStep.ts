// The step the recorder goes through one at a time and records (screens/recorder/plan.ts): a
// story's (the engine's PlanStep), or one imported from a script (roadmap #16), which can also go
// back, forward or reload, switch to a new tab and wait until something shows. Here, below the
// screens, so the importer can make them.
import type { PlanStep } from '../../engine/engine';

export interface WalkStep extends Omit<PlanStep, 'action'> {
  action: PlanStep['action'] | 'switchTab' | 'waitUntil';
  nav?: 'url' | 'reload' | 'back' | 'forward';
  /** An imported step whose words came from the page's code, or a wider locator than the script's: always asks before it's done. */
  check?: boolean;
}

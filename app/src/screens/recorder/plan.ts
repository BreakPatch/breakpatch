// "Write a test from a story" (Breakpatch Team, roadmap #10; engine/PROTOCOL.md "A test from a
// story"). The engine proposes the story's steps (`record.plan`); the recorder goes through them
// one at a time with the describe box's own flow: the target is found on the live page (the fast
// locator first, then the AI assistant), shown for Confirm, Try again, Skip or Edit, and recorded
// like a clicked step. These are the words and the mapping; the state is in useRecorder.
import type { PlanStep } from '../../engine/engine';
import { GENERATED } from '../../engine/labels';
import { SCROLL_PX, type Intent } from './intent';

export type PlanItemState = 'todo' | 'done' | 'skipped';
export interface PlanItem extends PlanStep { state: PlanItemState }

/** The steps of a story being gone through. `index`: the step being asked about (steps.length when all are answered). */
export interface PlanRun { steps: PlanItem[]; index: number; note?: string; dropped?: number }

const into = (s: PlanStep) => s.target ?? 'the field that has the focus';

/** The step in plain words: "Click the Sign up button", 'Type "Ada" into the Name field'; on a phone or tablet (`touch`) "Tap …". */
export function planSentence(s: PlanStep, { touch = false }: { touch?: boolean } = {}): string {
  switch (s.action) {
    case 'click': return `${touch ? 'Tap' : 'Click'} ${s.target}`;
    case 'doubleClick': return `${touch ? 'Double-tap' : 'Double-click'} ${s.target}`;
    case 'rightClick': return `Right-click ${s.target}`;
    case 'hover': return `Hover over ${s.target}`;
    case 'write':
      if (s.secretRef) return `Type the saved secret ${s.secretRef} into ${into(s)}`;
      if (s.generated) return `Type ${GENERATED[s.generated]} into ${into(s)}`;
      if (s.text !== undefined) return `Type "${s.text}" into ${into(s)}`;
      return `Type into ${into(s)}`;
    case 'navigate': return `Go to ${s.url}`;
    case 'scroll': return `Scroll ${s.direction ?? 'down'}${s.target ? ` in ${s.target}` : ''}`;
    case 'waitFor': return `Wait ${s.seconds ?? 2} seconds`;
    case 'checkpoint': return `Check that ${s.target} shows`;
  }
}

/** What the step still needs from the person before it can be done, in words, or null. */
export function planNeeds(s: PlanStep): string | null {
  if (s.action !== 'write' || (!s.needs && (s.text !== undefined || s.secretRef || s.generated))) return null;
  return s.needs === 'secret' ? 'Pick the saved secret to type here. Breakpatch never makes up a password.'
    : "Say what to type here. Breakpatch only types what your story says, a saved secret you picked, or a generated value.";
}

/** Said with a step that looks like it deletes, pays or sends something. */
export const CAREFUL_NOTE = 'This step may delete, pay for or send something. Check it before you confirm.';

/** The step as the describe flow's intent: what to find and what Confirm does with it. */
export function planIntent(s: PlanStep): Intent {
  const base = { repeat: 1, from: 'plan' as const, ...(s.target ? { target: s.target } : {}) };
  switch (s.action) {
    case 'write': return { ...base, action: 'write', ...(s.secretRef ? { secretRef: s.secretRef } : s.generated ? { generated: s.generated } : { text: s.text ?? '' }) };
    case 'navigate': return { ...base, action: 'navigate', url: s.url };
    case 'scroll': return { ...base, action: 'scroll', direction: s.direction ?? 'down', distance: SCROLL_PX };
    case 'waitFor': return { ...base, action: 'waitFor', seconds: s.seconds ?? 2 };
    default: return { ...base, action: s.action };
  }
}

/** A new run through a plan's steps, from the first. */
export function planRun(steps: PlanStep[], note?: string, dropped?: number): PlanRun {
  return { steps: steps.map(s => ({ ...s, state: 'todo' as const })), index: 0, ...(note ? { note } : {}), ...(dropped ? { dropped } : {}) };
}

/** The step at `i` answered (done or skipped), and the next one asked about. */
export function answered(run: PlanRun, i: number, state: Exclude<PlanItemState, 'todo'>): PlanRun {
  return { ...run, steps: run.steps.map((s, k) => (k === i ? { ...s, state } : s)), index: Math.max(run.index, i + 1) };
}

/** "5 steps added, 1 skipped." when the last step has been answered. */
export function planDoneText(run: PlanRun): string {
  const done = run.steps.filter(s => s.state === 'done').length, skipped = run.steps.filter(s => s.state === 'skipped').length;
  const added = done === 1 ? '1 step added' : `${done} steps added`;
  return `${added}${skipped ? `, ${skipped} skipped` : ''}. Check them, then save the test.`;
}

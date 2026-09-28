// Plain words for why a step failed (ui-requirements §5.10). One headline per FailReason,
// used as the step's note, the Run view strip and the report heading, plus a one-line reason.
import type { StepRun, FailReason, Step } from '../../data/types';

/** "the Done button" from "Done button, bottom right of the Create project dialog". */
export function targetName(step: Pick<Step, 'target' | 'label' | 'action'>): string {
  const raw = (step.target ?? '').split(',')[0].trim().replace(/^(the|a|an)\s+/i, '');
  if (raw && !/^(spot you clicked|area you picked|focused field)$/i.test(raw)) return `the ${raw}`;
  if (step.action === 'write') return 'the field to write in';
  return 'what to click';
}

const VERB: Partial<Record<Step['action'], string>> = {
  click: 'click', doubleClick: 'double-click', longClick: 'press', rightClick: 'right-click', hover: 'point at',
  write: 'write in', drag: 'drag', swipe: 'swipe', scroll: 'scroll', upload: 'upload to',
};

/** Over this, a step says where its time went. */
export const SLOW_MS = 2000;
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * "Took 6.1 s: 5.2 s waiting for the page to finish changing after step 2." for a step that took
 * over SLOW_MS, naming the phase that took longest. `prev` is the number of the step before it.
 */
export function slowNote(t: StepRun['timings'], prev?: number | string): string | undefined {
  if (!t) return undefined;
  const parts: [number, string][] = [
    [t.preMs ?? 0, `waiting for the page to finish changing${prev !== undefined ? ` after step ${prev}` : ''}`],
    [t.actionMs ?? 0, 'doing the step'],
    [t.settleMs ?? 0, t.settled === false ? 'waiting for the page, which never stopped changing' : 'waiting for the page to settle after it'],
    [t.postMs ?? 0, 'waiting for the page to look as it did when recorded'],
  ];
  const total = parts.reduce((a, [ms]) => a + ms, 0);
  if (total <= SLOW_MS) return undefined;
  const [ms, what] = parts.reduce((a, b) => (b[0] > a[0] ? b : a));
  return `Took ${secs(total)}: ${secs(ms)} ${what}.`;
}

/** A pass that wasn't a plain match with the recording, in words for the report. */
export function passNote(r: Pick<StepRun, 'passedBy' | 'why'> | undefined): string | undefined {
  if (r?.passedBy === 'gone') return 'Passed: the dialog closed. The page behind it looked different from when it was recorded.';
  if (r?.passedBy === 'note') return r.why ?? 'Passed: the step did what its note says.';
  return undefined;
}

/** The headline: "Couldn't find the Done button". */
export function reasonTitle(reason: FailReason | undefined, step: Pick<Step, 'target' | 'label' | 'action'>): string {
  switch (reason) {
    case 'targetNotFound': case 'healFailed': return `Couldn't find ${targetName(step)}`;
    case 'unexpectedScreen': return step.action === 'checkpoint' ? "The screen didn't look as expected" : "The screen didn't look as expected after this step";
    case 'noChange': return 'Nothing happened after this step';
    case 'timeout': return 'Waited too long for the page';
    case 'healingUnavailable': return "The AI assistant isn't downloaded, so this couldn't be fixed automatically";
    case 'secretMissing': return 'Saved secret is missing on this Mac';
    case 'setUpFailed': return "The set-up call didn't work";
    case 'stopped': return 'You stopped the run';
    case 'fileMissing': return "The file to upload isn't in the tests folder";
    default: return 'This step failed';
  }
}

/** One plain sentence (or two) under the headline. */
export function reasonText(reason: FailReason | undefined, step: Pick<Step, 'target' | 'label' | 'action' | 'secretRef'> & Partial<Pick<Step, 'file'>>): string {
  const verb = VERB[step.action] ?? 'use';
  switch (reason) {
    case 'targetNotFound': return `It wasn't where it was when this step was recorded, so there was nothing to ${verb}. The run stopped here.`;
    case 'healFailed': return "The AI assistant looked for it, but what it found didn't match the recording. The run stopped here.";
    case 'unexpectedScreen':
      if (step.action === 'checkpoint') return 'The area this step checks looked different from when it was recorded. The run stopped here.';
      if (step.action === 'downloadCheck') return "The downloaded file wasn't the type or size this step expects. The run stopped here.";
      return 'The page looked different from when it was recorded once the step was done. The run stopped here.';
    case 'noChange': return 'The step was done, but nothing changed on the page the way it did when it was recorded. The run stopped here.';
    case 'timeout':
      if (step.action === 'waitUntil') return 'What this step waits for never appeared. The run stopped here.';
      return "The page didn't finish loading or settle in time. The run stopped here.";
    case 'healingUnavailable': return 'Download it in Settings → AI assistant, then run again.';
    case 'secretMissing': return `Add ${step.secretRef ?? 'the saved secret'} in Settings → Saved secrets, then run again.`;
    case 'setUpFailed': return "The call before the test didn't answer with success, so no steps ran.";
    case 'stopped': return "The steps from here on didn't run.";
    case 'fileMissing': return `${step.file ?? 'The file'} isn't in the tests folder. Put it back in the files folder, or re-record the step.`;
    default: return 'The run stopped here.';
  }
}

/** What to try, under the side-by-side screenshots. */
export function reasonAdvice(reason: FailReason | undefined): string {
  switch (reason) {
    case 'secretMissing': return 'Saved secrets stay on each Mac. Add it here once and every test that uses it can run.';
    case 'healingUnavailable': return 'Without the AI assistant, a moved button fails the run. Re-record the step, or download the assistant.';
    case 'setUpFailed': return 'Check that the set-up address works and that the app is running, then run again.';
    case 'timeout': return 'If the app was slow this time, run again. If it always takes longer now, re-record this step.';
    case 'stopped': return 'Run again to go through every step.';
    default: return 'If the app changed on purpose, re-record this step. If it looks like a bug in the app, send the report to a developer.';
  }
}

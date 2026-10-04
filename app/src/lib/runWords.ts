// The words for a run that the screens and the exported report share: where it ran, who ran it,
// why a step failed and what to try, how long it took. breakpatch-ci's report (the open engine's
// breakpatch_engine/report/view.py) repeats them, so the two are changed together; the golden
// files in engine/tests/fixtures/report/ check they agree. Plain data and functions only: lib/
// imports nothing from screens/ or components/.
import type { FailReason, Run, RunSource, Step, StepRun } from '../data/types';
import { isMac, osText, ThisComputer } from './osWords';

export const WHERE: Record<RunSource, { label: string; icon: string }> = {
  // A getter: the words are the computer's the app runs on (lib/osWords.ts).
  desktop: { get label() { return ThisComputer(); }, get icon() { return isMac() ? 'laptop_mac' : 'computer'; } },
  ci: { label: 'CI', icon: 'cloud' },
  runner: { label: 'Local runner', icon: 'dns' },
};

/**
 * Where a run ran, in words about the run's own machine (not the one showing it), so the app's
 * report and breakpatch-ci's (report/view.py where_text) say the same: a desktop run says "This
 * Mac" or "This PC" by the system it ran on. A run records that system only when it differs from
 * where the test was recorded (ranOn, or a system mismatch's ranOn). Without one it ran on the
 * test's own system (`recordedOn`, when known), else on this computer: the one making the report.
 * A system it doesn't know says "Desktop app". The runner's and CI's runs say so.
 */
export function whereText(
  run: { source: RunSource | string; ranOn?: { os?: string }; systemMismatch?: { ranOn?: { os?: string } } },
  recordedOn?: { os?: string },
): string {
  if (run.source !== 'desktop') return WHERE[run.source as RunSource]?.label ?? String(run.source ?? '');
  const os = run.ranOn?.os || run.systemMismatch?.ranOn?.os || (run.systemMismatch ? undefined : recordedOn?.os);
  if (!os) return isMac() ? 'This Mac' : 'This PC';
  if (os === 'macOS') return 'This Mac';
  if (os === 'Windows' || os === 'Linux') return 'This PC';
  return 'Desktop app';
}

/** Who started a run: a person's name or the service account ("Nightly suite"). */
export function runBy(r: Pick<Run, 'startedBy'>): string {
  return 'name' in r.startedBy ? r.startedBy.name : r.startedBy.serviceAccount;
}

/** A step whose check covered nothing (it compares nothing): shown on the step, in amber. */
export const UNCHECKED_NOTE = "This step's check covers nothing. Re-record it.";

/** "the Done button" from "Done button, bottom right of the Create project dialog". */
export function targetName(step: Pick<Step, 'target' | 'label' | 'action'>): string {
  const raw = (step.target ?? '').split(',')[0].trim().replace(/^(the|a|an)\s+/i, '');
  if (raw && !/^(spot you clicked|area you picked|focused field)$/i.test(raw)) return `the ${raw}`;
  if (step.action === 'write') return 'the field to write in';
  return 'what to click';
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
    case 'secretMissing': return osText('Saved secret is missing on this Mac');
    case 'setUpFailed': return "The set-up call didn't work";
    case 'stopped': return 'You stopped the run';
    case 'fileMissing': return "The file to upload isn't in the tests folder";
    default: return 'This step failed';
  }
}

/** The verb for what a step does, in reasonText. */
const VERB: Partial<Record<Step['action'], string>> = {
  click: 'click', doubleClick: 'double-click', longClick: 'press', rightClick: 'right-click', hover: 'point at',
  write: 'write in', drag: 'drag', swipe: 'swipe', scroll: 'scroll', upload: 'upload to',
};

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
    case 'secretMissing': return osText('Saved secrets stay on each Mac. Add it here once and every test that uses it can run.');
    case 'healingUnavailable': return 'Without the AI assistant, a moved button fails the run. Re-record the step, or download the assistant.';
    case 'setUpFailed': return 'Check that the set-up address works and that the app is running, then run again.';
    case 'timeout': return 'If the app was slow this time, run again. If it always takes longer now, re-record this step.';
    case 'stopped': return 'Run again to go through every step.';
    default: return 'If the app changed on purpose, re-record this step. If it looks like a bug in the app, send the report to a developer.';
  }
}

/** "51 s", "1 min 8 s", "12 min". */
export function tookText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60), s = total % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

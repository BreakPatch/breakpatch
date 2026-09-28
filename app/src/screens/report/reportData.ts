// Pure pieces of the run report: what each step's detail says, where the markers go, the
// text "Copy details" puts on the clipboard.
import type { Box, Point, Run, Step, StepRun } from '../../data/types';
import { around, lockBox } from '../../components/live';
import { formatDateTime, formatDuration } from '../../components/common/format';
import { runBy, WHERE } from '../../components/common/runs';
import { reasonText, reasonTitle, targetName } from '../run/reasons';

export type DetailKind = 'failed' | 'fixed' | 'passed' | 'notRun' | 'stopped';

export function detailKind(r: StepRun | undefined): DetailKind {
  if (!r) return 'notRun';
  if (r.result === 'failed') return r.reason === 'stopped' ? 'stopped' : 'failed';
  if (r.result === 'healed') return 'fixed';
  return r.result === 'passed' ? 'passed' : 'notRun';
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function detailText(kind: DetailKind, step: Step, r: StepRun | undefined, canAccept: boolean): { headline: string; body: string } {
  switch (kind) {
    case 'failed': return { headline: reasonTitle(r?.reason, step), body: reasonText(r?.reason, step) };
    case 'stopped': return { headline: reasonTitle('stopped', step), body: reasonText('stopped', step) };
    case 'fixed': return {
      headline: `${cap(targetName(step))} had moved. The AI assistant found it.`,
      body: `It was used in the new position and the screen afterwards looked right.${canAccept ? ' Accept to save the new position, or the next run will look in the old spot again.' : ''}`,
    };
    case 'passed': return { headline: 'This step passed', body: 'It found what it expected, and the screen afterwards looked right.' };
    case 'notRun': return { headline: "This step didn't run", body: 'The run stopped before it got here.' };
  }
}

/** Screenshots are worth showing for these: the page is part of the reason. */
export function showsScreens(r: StepRun | undefined): boolean {
  return !!r && r.result === 'failed' && !['secretMissing', 'setUpFailed', 'stopped', 'healingUnavailable'].includes(r.reason ?? '');
}

const EXPECT: Partial<Record<Step['action'], string>> = {
  click: 'Click here', doubleClick: 'Double-click here', longClick: 'Press here', rightClick: 'Right-click here', hover: 'Point here',
  write: 'Write here', drag: 'Drag from here', swipe: 'Swipe here', scroll: 'Scroll here', checkpoint: 'Check here', waitUntil: 'Wait for this', upload: 'Upload here',
};
export const expectLabel = (s: Step) => EXPECT[s.action] ?? 'Locked here';

/** Old and new position of a fixed step: the locked area's size, centred on each point. */
export function fixBoxes(step: Step | undefined, oldAt: Point, newAt: Point): { old: Box; now: Box } {
  const b = step ? lockBox(step) : null;
  const rx = b ? Math.max(12, Math.round((b[2] - b[0]) / 2)) : 24, ry = b ? Math.max(12, Math.round((b[3] - b[1]) / 2)) : 24;
  return { old: around(oldAt, rx, ry), now: around(newAt, rx, ry) };
}

/** A fixed step with its locked area moved to where the AI assistant found it (Accept new position). */
export function movedStep(step: Step, oldAt: Point, newAt: Point): Step {
  const dx = newAt[0] - oldAt[0], dy = newAt[1] - oldAt[1];
  const shift = (b: Box): Box => [b[0] + dx, b[1] + dy, b[2] + dx, b[3] + dy];
  return {
    ...step, at: newAt,
    ...(step.pre ? { pre: { ...step.pre, region: shift(step.pre.region) } } : {}),
  };
}

/** Plain text for a developer: what ran, where, and what went wrong. */
export function copyDetails(run: Run, step: Step | undefined, number: string, r: StepRun | undefined, appName: string): string {
  const lines = [
    `Breakpatch run report`,
    `Test: ${appName} · ${run.testName} (version ${run.testVersion})`,
    `Result: ${run.result === 'fail' ? 'Failed' : run.healedCount ? 'Passed with fixes' : 'Passed'}`,
    `When: ${formatDateTime(run.startedAt)} · took ${formatDuration(run.durationMs)}`,
    `Run by: ${runBy(run)} · ${WHERE[run.source].label} · ${run.machine}`,
    `Run ID: ${run.id}`,
  ];
  if (step && r) {
    lines.push('', `Step ${number}: ${step.label}`);
    if (r.result === 'failed') lines.push(`${reasonTitle(r.reason, step)} (${r.reason ?? 'failed'})`, reasonText(r.reason, step));
    if (step.target) lines.push(`What to look for: ${step.target}`);
    if (step.at) lines.push(`Position: ${step.at[0]}, ${step.at[1]}`);
    if (r.preDistance !== undefined) lines.push(`Before-step match distance: ${r.preDistance}`);
    if (r.postDistance !== undefined) lines.push(`After-step match distance: ${r.postDistance}`);
    if (r.screenshotPath) lines.push(`Screenshot: ${r.screenshotPath}`);
  }
  return lines.join('\n');
}

/** "51 s", "1 min 8 s", "12 min". */
export function tookText(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} s`;
  const m = Math.floor(total / 60), s = total % 60;
  return s ? `${m} min ${s} s` : `${m} min`;
}

// The write-up of a failed step for a developer (roadmap #5): a title and a Markdown body with the
// steps up to the failure, expected vs seen, the reason, where and when it ran, and links. Community
// copies it (Copy as Markdown); Team's Create issue sends the same text to GitHub, Linear or Jira.
import type { Run, Step, StepRun, Test } from '../../data/types';
import { formatDateTime } from '../../components/common/format';
import { runBy, WHERE } from '../../components/common/runs';
import { preorder, rowRefs } from '../run/resolve';
import { reasonText, reasonTitle, targetName } from '../run/reasons';
import { systemNote } from './reportData';

export interface IssueInput {
  run: Run;
  test: Test | undefined;
  /** Steps as the run tested them (shared steps resolved). */
  steps: Step[];
  step: Step;
  stepRun: StepRun | undefined;
  /** "5", or "2.3" inside a shared-steps card. */
  number: string;
  appName: string;
  /** The report through https://breakpatch.dev/report (Team), when there is one. */
  reportUrl?: string;
  /** The screenshot at a web address (Team uploads it), else the local path is named. */
  imageUrl?: string;
  /** Leave the local screenshot path out (an issue goes to people who don't have this Mac). */
  noLocalPaths?: boolean;
}

export interface IssueContent { title: string; markdown: string }

/** The AI assistant's explanation (#7), on the step's result or the run, when there is one. */
export function explanationIn(...from: unknown[]): { summary: string; cause?: string; suggestion?: string } | undefined {
  for (const x of from) {
    const e = (x as { explanation?: { summary?: unknown; cause?: unknown; suggestion?: unknown } } | undefined)?.explanation;
    if (e && typeof e.summary === 'string' && e.summary.trim()) {
      const opt = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
      return { summary: e.summary.trim(), ...(opt(e.cause) ? { cause: opt(e.cause) } : {}), ...(opt(e.suggestion) ? { suggestion: opt(e.suggestion) } : {}) };
    }
  }
  return undefined;
}

/** Markdown's own characters written as text. */
export function mdText(s: string): string { return s.replace(/([\\`*_[\]<>|#])/g, '\\$1'); }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const EXPECTS: Record<NonNullable<Step['expect']>, string> = {
  newPage: 'A new page opens.', closes: 'What was open closes.', appears: 'Something new appears.',
  changes: 'The page changes.', noChange: 'The page stays as it is.',
};

/** What the step should have done, in words. */
export function expectedText(step: Step): string {
  if (step.expectNote?.trim()) return step.expectNote.trim();
  if (step.expect) return EXPECTS[step.expect];
  switch (step.action) {
    case 'checkpoint': return 'The area this step checks looks as it did when the step was recorded.';
    case 'waitUntil': return 'What this step waits for appears.';
    case 'navigate': return 'The page opens.';
    case 'downloadCheck': return 'The file downloads, of the right type and size.';
    default: return `${cap(targetName(step))} is where it was when the step was recorded, and the page afterwards looks as it did then.`;
  }
}

/** "Create a project: step 5 Click Done failed: couldn't find the Done button" */
export function issueTitle(run: Pick<Run, 'testName'>, step: Step, number: string, r: StepRun | undefined): string {
  const why = reasonTitle(r?.reason, step);
  return `${run.testName}: step ${number} ${step.label} failed: ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

/** The steps as they ran, up to and including the one that failed: "1. Open the page", "2.3 Click Next". */
export function stepsUpTo(steps: Step[], stepId: string): { number: string; label: string }[] {
  const refs = rowRefs(steps);
  const out: { number: string; label: string }[] = [];
  for (const s of preorder(steps)) {
    out.push({ number: refs.get(s.id)?.number ?? '', label: s.label });
    if (s.id === stepId) break;
  }
  return out;
}

const SOURCE: Record<Run['source'], string> = { desktop: 'a person, on their Mac', runner: 'the local runner', ci: 'CI' };

export function issueContent(i: IssueInput): IssueContent {
  const { run, test, steps, step, stepRun: r, number, appName } = i;
  const lines: string[] = [];
  const why = explanationIn(r, run);
  lines.push(`**${mdText(reasonTitle(r?.reason, step))}.** ${mdText(reasonText(r?.reason, step))}`, '');
  if (why) {
    lines.push(`**The AI assistant says:** ${mdText(why.summary)}`);
    if (why.cause) lines.push(`- Cause: ${mdText(why.cause)}`);
    if (why.suggestion) lines.push(`- Try: ${mdText(why.suggestion)}`);
    lines.push('');
  }
  lines.push('### Steps', '');
  for (const s of stepsUpTo(steps, step.id)) {
    const failed = s.number === number;
    lines.push(`${s.number}. ${mdText(s.label)}${failed ? ' ← failed here' : ''}`);
  }
  lines.push('', '### Expected', '', mdText(expectedText(step)), '', '### Seen', '', mdText(`${reasonTitle(r?.reason, step)}.`));
  const note = systemNote(run, r);
  if (note) lines.push('', mdText(note));
  if (i.imageUrl) lines.push('', `![Screenshot of step ${number}](${i.imageUrl})`);
  else if (r?.screenshotPath && !i.noLocalPaths) lines.push('', `Screenshot: \`${r.screenshotPath.replace(/`/g, '')}\``);
  lines.push('', '### Where', '',
    `- App: ${mdText(appName)}`,
    ...(test?.startUrl ? [`- Start address: ${mdText(test.startUrl)}`] : []),
    `- Test: ${mdText(run.testName)}, version ${run.testVersion}`,
    `- Run by: ${mdText(runBy(run))}, ${SOURCE[run.source]} (${WHERE[run.source].label}), on ${mdText(run.machine)}`,
    `- When: ${formatDateTime(run.startedAt)}`,
    `- Run ID: ${mdText(run.id)}`);
  if (step.target) lines.push(`- What to look for: ${mdText(step.target)}`);
  if (i.reportUrl) lines.push('', `[Open the report in Breakpatch](${i.reportUrl})`);
  lines.push('', '_Made with Breakpatch._');
  return { title: issueTitle(run, step, number, r), markdown: lines.join('\n') + '\n' };
}

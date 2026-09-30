// The write-up of a failed step for a developer (roadmap #5): a title and a Markdown body with the
// steps up to the failure, expected vs seen, the reason, where and when it ran, and links. Community
// copies it (Copy as Markdown); Team's Create issue sends the same text to GitHub, Linear or Jira.
import type { Run, Step, StepRun, Test } from '../../data/types';
import { formatDateTime } from '../../components/common/format';
import { runBy, WHERE } from '../../components/common/runs';
import { preorder, rowRefs } from '../run/resolve';
import { reasonText, reasonTitle, targetName } from '../run/reasons';
import { systemNote } from './reportData';
import { CAUSE_TEXT, SUGGESTION_TEXT } from '../../lib/explain';

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

/** A run of text with its marks. Plain text: the renderers escape it for their format. */
export interface Inline { text: string; strong?: boolean; em?: boolean; code?: boolean; href?: string }
/** One block of the write-up. */
export type IssueBlock =
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'heading'; text: string }
  | { kind: 'bullets'; items: Inline[][] }
  /** The steps as they ran: numbers as written ("2.3" inside shared steps), the failed one marked. */
  | { kind: 'steps'; items: { number: string; label: string; failed: boolean }[] }
  | { kind: 'image'; url: string; alt: string };

/**
 * The write-up as a small document: the same content for every format. toMarkdown() is what
 * Copy as Markdown, GitHub and Linear get; Team renders the blocks to Jira's ADF itself, so no
 * format depends on another's escaping.
 */
export interface IssueDoc { title: string; blocks: IssueBlock[]; toMarkdown(): string }

export interface IssueContent { title: string; markdown: string; doc: IssueDoc }

const mdInline = (i: Inline): string => {
  if (i.code) return `\`${i.text.replace(/`/g, '')}\``;
  let t = mdText(i.text);
  if (i.href) t = `[${t}](${i.href})`;
  if (i.strong) t = `**${t}**`;
  if (i.em) t = `_${t}_`;
  return t;
};
const mdLine = (inline: Inline[]) => inline.map(mdInline).join('');

/** The blocks as Markdown, the dialect GitHub, Linear and Copy as Markdown take. */
export function blocksToMarkdown(blocks: IssueBlock[]): string {
  const out = blocks.map(b => {
    switch (b.kind) {
      case 'paragraph': return mdLine(b.inline);
      case 'heading': return `### ${mdText(b.text)}`;
      case 'bullets': return b.items.map(i => `- ${mdLine(i)}`).join('\n');
      case 'steps': return b.items.map(s => `${s.number}. ${mdText(s.label)}${s.failed ? ' ← failed here' : ''}`).join('\n');
      case 'image': return `![${mdText(b.alt)}](${b.url})`;
    }
  });
  return out.join('\n\n') + '\n';
}

export function issueDoc(title: string, blocks: IssueBlock[]): IssueDoc {
  return { title, blocks, toMarkdown: () => blocksToMarkdown(blocks) };
}

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
  const blocks: IssueBlock[] = [];
  const t = (text: string, marks: Omit<Inline, 'text'> = {}): Inline => ({ text, ...marks });
  const why = explanationIn(r, run);
  blocks.push({ kind: 'paragraph', inline: [t(`${reasonTitle(r?.reason, step)}.`, { strong: true }), t(` ${reasonText(r?.reason, step)}`)] });
  if (why) {
    blocks.push({ kind: 'paragraph', inline: [t('The AI assistant says:', { strong: true }), t(` ${why.summary}`)] });
    // The explanation's cause and suggestion are codes (data/types.ts Explanation): their plain words, as the report shows them.
    const cause = why.cause ? (CAUSE_TEXT as Record<string, string>)[why.cause] : undefined;
    const next = why.suggestion ? (SUGGESTION_TEXT as Record<string, string>)[why.suggestion] : undefined;
    const items = [cause && [t(`Likely cause: ${cause}`)], next && [t(`Suggested: ${next}`)]].filter((x): x is Inline[] => !!x);
    if (items.length) blocks.push({ kind: 'bullets', items });
  }
  blocks.push({ kind: 'heading', text: 'Steps' },
    { kind: 'steps', items: stepsUpTo(steps, step.id).map(s => ({ ...s, failed: s.number === number })) },
    { kind: 'heading', text: 'Expected' }, { kind: 'paragraph', inline: [t(expectedText(step))] },
    { kind: 'heading', text: 'Seen' }, { kind: 'paragraph', inline: [t(`${reasonTitle(r?.reason, step)}.`)] });
  const note = systemNote(run, r);
  if (note) blocks.push({ kind: 'paragraph', inline: [t(note)] });
  if (i.imageUrl) blocks.push({ kind: 'image', url: i.imageUrl, alt: `Screenshot of step ${number}` });
  else if (r?.screenshotPath && !i.noLocalPaths) blocks.push({ kind: 'paragraph', inline: [t('Screenshot: '), t(r.screenshotPath, { code: true })] });
  blocks.push({ kind: 'heading', text: 'Where' }, {
    kind: 'bullets', items: [
      [t(`App: ${appName}`)],
      ...(test?.startUrl ? [[t(`Start address: ${test.startUrl}`)]] : []),
      [t(`Test: ${run.testName}, version ${run.testVersion}`)],
      [t(`Run by: ${runBy(run)}, ${SOURCE[run.source]} (${WHERE[run.source].label}), on ${run.machine}`)],
      [t(`When: ${formatDateTime(run.startedAt)}`)],
      [t(`Run ID: ${run.id}`)],
      ...(step.target ? [[t(`What to look for: ${step.target}`)]] : []),
    ],
  });
  if (i.reportUrl) blocks.push({ kind: 'paragraph', inline: [t('Open the report in Breakpatch', { href: i.reportUrl })] });
  blocks.push({ kind: 'paragraph', inline: [t('Made with Breakpatch.', { em: true })] });
  const doc = issueDoc(issueTitle(run, step, number, r), blocks);
  return { title: doc.title, markdown: doc.toMarkdown(), doc };
}

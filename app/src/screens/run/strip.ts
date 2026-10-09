// What the Run view says about the run right now: the strip under the page, the steps panel's
// count, the notes on rows and the hairline. Pure, so every state is testable.
import type { Step } from '../../data/types';
import { plural } from '../../components/common/format';
import { preorder, rowIds, rowRefs } from './resolve';
import { passNote, reasonTitle, slowNote, UNCHECKED_NOTE, targetName } from './reasons';
import { progress, type RunView } from './runState';

export type Tone = 'running' | 'passed' | 'fixed' | 'failed' | 'muted';
export interface Strip { icon: string; tone: Tone; motion?: 'spin' | 'pulse'; title: string; text: string }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface RunInfo {
  byId: Map<string, Step>;
  refs: ReturnType<typeof rowRefs>;
  rows: Step[];
}

export function runInfo(steps: Step[]): RunInfo {
  const byId = new Map(preorder(steps).map(s => [s.id, s]));
  const ids = rowIds(steps);
  return { byId, refs: rowRefs(steps), rows: ids.map(id => byId.get(id)!) };
}

/** "3", or "2.3" inside a shared-steps card. */
export const numberOf = (info: RunInfo, id: string | undefined) => (id ? info.refs.get(id)?.number ?? '' : '');
/** The top-level number (a shared-steps child counts as its card): "Step 2 of 8". */
export const rowNumber = (info: RunInfo, id: string | undefined) => {
  const rowId = id ? info.refs.get(id)?.rowId : undefined;
  return rowId ? info.rows.findIndex(r => r.id === rowId) + 1 : 0;
};

export function runStrip(view: RunView, info: RunInfo): Strip {
  const total = info.rows.length;
  if (view.phase === 'error') return { icon: 'error', tone: 'failed', title: "Couldn't start the run", text: view.error ?? 'Try again.' };
  if (view.phase === 'idle' || view.phase === 'starting') return { icon: 'progress_activity', tone: 'running', motion: 'spin', title: 'Starting…', text: total ? plural(total, 'step') : 'Getting the steps ready' };
  if (view.phase === 'running') {
    const cur = view.currentId ? info.byId.get(view.currentId) : undefined;
    const n = rowNumber(info, view.currentId);
    if (cur && view.states[cur.id] === 'looking') {
      return { icon: 'auto_awesome', tone: 'running', motion: 'pulse', title: `Looking for ${targetName(cur)}…`, text: "It's not where it was last time. This takes a few seconds." };
    }
    return { icon: 'progress_activity', tone: 'running', motion: 'spin', title: cur?.label ?? 'Opening the start page…', text: n ? `Step ${n} of ${total}` : plural(total, 'step') };
  }
  // ended
  const failed = view.failedId ? info.byId.get(view.failedId) : undefined;
  const at = rowNumber(info, view.failedId);
  if (view.result === 'fail' && failed) {
    const reason = view.reasons[failed.id];
    if (reason === 'stopped') return { icon: 'block', tone: 'muted', title: 'You stopped the run', text: `It stopped at step ${at}. The steps after it didn't run.` };
    return { icon: 'cancel', tone: 'failed', title: reasonTitle(reason, failed), text: `The run stopped at step ${at}. See the report for what was expected.` };
  }
  if (view.result === 'fail') return { icon: 'cancel', tone: 'failed', title: 'Failed', text: 'See the report for what happened.' };
  const fixedIds = Object.keys(view.fixes).filter(id => !info.byId.get(id)?.steps);
  if (fixedIds.length) {
    const first = info.byId.get(fixedIds[0]);
    const what = first ? cap(targetName(first)) : 'A button';
    return {
      icon: 'auto_fix_high', tone: 'fixed', title: `Passed, ${plural(fixedIds.length, 'step')} fixed automatically`,
      text: `${what} moved and the AI assistant found it. The new position isn't saved until you accept it in the report.`,
    };
  }
  return { icon: 'check_circle', tone: 'passed', title: 'Passed', text: `All ${plural(total, 'step')} worked.` };
}

/** The steps panel's heading count. */
export function stepCountText(view: RunView, info: RunInfo): string {
  const total = info.rows.length;
  if (view.phase === 'running') return `Step ${Math.max(1, rowNumber(info, view.currentId))} of ${total}`;
  if (view.phase === 'ended') {
    if (view.result === 'fail' && view.failedId) return `Stopped at step ${rowNumber(info, view.failedId)}`;
    return 'Finished';
  }
  return plural(total, 'step');
}

/** Second line on rows: the fail reason (on the row, or on the shared-steps card it's in). */
export function rowNotes(view: RunView, info: RunInfo): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const [id, state] of Object.entries(view.states)) {
    const s = info.byId.get(id);
    const rowId = info.refs.get(id)?.rowId;
    if (!s || !rowId) continue;
    if (state === 'looking') notes[rowId] = 'Looking for the button…';
    else if (state === 'fixed' && !s.steps) notes[rowId] = `${/button/i.test(s.target ?? '') ? 'Button moved' : 'Moved'} · new position not saved yet`;
  }
  for (const id of Object.keys(view.unchecked ?? {})) {
    const rowId = info.refs.get(id)?.rowId;
    if (rowId && !notes[rowId]) notes[rowId] = UNCHECKED_NOTE;
  }
  // A Call step says what it replied, before how long it took.
  for (const [id, p] of Object.entries(view.passes ?? {})) {
    const rowId = info.refs.get(id)?.rowId;
    const text = passNote(p);
    if (rowId && text && !notes[rowId]) notes[rowId] = text;
  }
  for (const [id, t] of Object.entries(view.timings ?? {})) {
    const rowId = info.refs.get(id)?.rowId;
    const n = numberOf(info, id);
    const text = slowNote(t, typeof n === 'number' && n > 1 ? n - 1 : undefined);
    if (rowId && text && !notes[rowId]) notes[rowId] = text;
  }
  if (view.failedId) {
    const s = info.byId.get(view.failedId);
    const reason = view.reasons[view.failedId];
    const rowId = info.refs.get(view.failedId)?.rowId;
    if (s && rowId) {
      const inCard = rowId !== view.failedId;
      notes[rowId] = reason === 'stopped' ? 'You stopped the run here' : inCard ? `Step ${numberOf(info, view.failedId)}: ${reasonTitle(reason, s)}` : reasonTitle(reason, s);
    }
  }
  return notes;
}

/** The 3 px hairline under the title bar. */
export function hairline(view: RunView, info: RunInfo): { value: number; tone: 'running' | 'passed' | 'failed' } {
  if (view.phase === 'ended') return { value: view.result === 'fail' ? progress(view.states, info.rows) : 1, tone: view.result === 'fail' ? 'failed' : 'passed' };
  if (view.phase === 'error') return { value: 0, tone: 'failed' };
  return { value: progress(view.states, info.rows), tone: 'running' };
}

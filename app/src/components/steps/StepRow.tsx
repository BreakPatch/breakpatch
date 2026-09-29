// One row of the steps list (README "Steps panel"): number, 30 px icon disc, label
// 14/600 with ellipsis, optional note, status on the right. Used by the Recorder (edit),
// the Run view (live statuses) and the Report.
import type { HTMLAttributes, KeyboardEvent, ReactNode } from 'react';
import type { Step } from '../../data/types';
import { Icon } from '../ui';
import { shortNote, stepIcon } from './stepText';

/** Run statuses a row can show (ui-requirements §7). */
export type RowStatus = 'passed' | 'running' | 'looking' | 'waiting' | 'failed' | 'notRun' | 'fixed' | 'added';

const STATUS: Record<RowStatus, { icon: string; word: string; cls: string }> = {
  passed: { icon: 'check_circle', word: 'Passed', cls: 'st-passed' },
  running: { icon: 'progress_activity', word: 'Running', cls: 'st-running' },
  looking: { icon: 'auto_awesome', word: 'Looking', cls: 'st-running' },
  waiting: { icon: 'schedule', word: 'Waiting', cls: 'st-muted' },
  failed: { icon: 'cancel', word: 'Failed', cls: 'st-failed' },
  notRun: { icon: 'block', word: 'Not run', cls: 'st-muted' },
  fixed: { icon: 'auto_fix_high', word: 'Fixed automatically', cls: 'st-fixed' },
  added: { icon: 'check_circle', word: 'Added', cls: 'st-passed' },
};

export interface StepRowProps {
  step: Step;
  /** Shown number, e.g. 3 or "9.1". */
  number: number | string;
  /** Loop nesting: each level indents 22 px and draws a 3 px accent left edge. */
  depth?: number;
  /** Accent tint + 1.5 px accent border, accent disc. */
  selected?: boolean;
  /** Run status on the right (spinner for running). Failed also tints the row red. */
  status?: RowStatus;
  /** Replaces the status word, e.g. "Fixed" in a narrow list. */
  statusText?: string;
  /** Second line under the label, 12 px (e.g. "Couldn't find the Done button", "Re-recorded"). */
  note?: ReactNode;
  noteTone?: 'muted' | 'failed' | 'passed' | 'fixed' | 'accent';
  /** The disc pulses while the screen is being checked for this step. */
  checking?: boolean;
  /** Extra content at the right, before the status (e.g. "5 steps" + chevron). */
  trailing?: ReactNode;
  onSelect?: () => void;
  /** Keyboard reorder (Alt + arrow keys). */
  onMove?: (delta: -1 | 1) => void;
  /** Content shown under the row, in the same card (the selected step expands in place). */
  children?: ReactNode;
  /** Props for the row header (drag and drop handlers, draggable). */
  headProps?: HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  /** A drop indicator line above or below the row while dragging. */
  dropEdge?: 'before' | 'after' | null;
  /** Fade up 8 px when it first appears. */
  fresh?: boolean;
  /** Show the whole note, wrapped (the report's reasons). */
  noteWrap?: boolean;
  /** A small dot by the number: not played since the change (the list says so once, above). */
  dot?: boolean;
}

export function StepRow(p: StepRowProps) {
  const { step, selected, status, depth = 0 } = p;
  const failed = status === 'failed';
  const isLoop = step.action === 'loop';
  const st = status ? STATUS[status] : null;
  const faintLabel = status === 'waiting' || status === 'notRun';
  const open = !!p.children;
  const tone = p.noteTone ?? 'muted';
  const cls = ['step-card', selected && 'sel', failed && 'failed', isLoop && 'loop', depth > 0 && 'nested', p.fresh && 'fresh', p.dropEdge && 'drop-' + p.dropEdge]
    .filter(Boolean).join(' ');
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); p.onSelect?.(); }
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && p.onMove) { e.preventDefault(); p.onMove(e.key === 'ArrowUp' ? -1 : 1); }
  };
  const label = `Step ${p.number}: ${step.label}${st ? `, ${p.statusText ?? st.word}` : ''}`;
  return (
    <div className={cls} style={depth ? { marginLeft: 22 * depth } : undefined} data-step-id={step.id}>
      <div className="step-head" role="button" tabIndex={0} aria-pressed={p.onSelect ? !!selected : undefined} aria-expanded={p.children ? true : undefined}
        aria-label={label} aria-keyshortcuts={p.onMove ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
        onClick={p.onSelect} onKeyDown={onKey} {...p.headProps}>
        <div className="step-n">{p.dot && <span className="step-dot" title="Not played since the change" />}{p.number}</div>
        <div className={'step-disc' + (p.checking ? ' checking' : '')}><Icon name={stepIcon(step)} size={17} /></div>
        <div className="step-main">
          <div className={'step-label' + (faintLabel ? ' faint' : '')}>{step.label}</div>
          {/* Closed: one short line, the whole note on hover. */}
          {p.note && !open && <div className={'step-note tone-' + tone + (p.noteWrap ? ' full' : '')} title={typeof p.note === 'string' ? p.note : undefined}>
            {typeof p.note === 'string' && !p.noteWrap ? shortNote(p.note) : p.note}</div>}
        </div>
        {p.trailing}
        {st && (
          <div className={'step-status ' + st.cls}>
            <Icon name={st.icon} size={18} className={status === 'running' ? 'spin' : status === 'looking' ? 'anim-pulse' : 'pop'} />
            {p.statusText ?? st.word}
          </div>
        )}
      </div>
      {/* Open: the whole note on a row of its own, under the head, not squeezed by the disc (DES-04). */}
      {p.note && open && <div className={'step-note step-note-row full tone-' + tone}>{p.note}</div>}
      {p.children}
    </div>
  );
}

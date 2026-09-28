// The steps panel (380 px, right side). Edit mode (Recorder, Shared steps editor): the
// selected step expands in place with What to look for, Re-record, Duplicate and Delete;
// drag or Alt + arrow keys reorder; loops indent their steps and, while open, end with a
// "Done repeating" chip. Run mode (Run view, Report): read-only rows with run statuses.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Step } from '../../data/types';
import { Icon } from '../ui';
import { StepRow, type RowStatus } from './StepRow';
import { stepIcon, stepNote } from './stepText';
import { countRows, duplicateStep, flatRows, moveAfter, moveBefore, moveBy, removeStep, updateStep, type RowInfo } from './stepTree';
import './steps.css';

export interface StepsPanelProps {
  steps: Step[];
  mode: 'edit' | 'run';
  /** Header title (default "Steps") and the text on its right (default "8 steps"). */
  title?: string;
  countText?: string;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  /** Edit mode: every change to the list (reorder, delete, duplicate, text, repeat count). */
  onChange?: (steps: Step[]) => void;
  /** Edit mode: "Re-record" pressed on a step. */
  onRerecord?: (id: string) => void;
  /** The step being re-recorded (note on the row). */
  rerecordingId?: string | null;
  /** The step whose screen check is running (disc pulses). */
  checkingId?: string | null;
  /** The loop new steps go into; shows "Done repeating" after its last step. */
  openLoopId?: string | null;
  onCloseLoop?: () => void;
  /** Run mode: status per step id, and an optional note per step id (e.g. the fail reason). */
  statuses?: Record<string, RowStatus>;
  notes?: Record<string, string>;
  /** Steps of a shared-steps card (resolved from its version), shown read-only when expanded. */
  groupSteps?: (step: Step) => Step[] | undefined;
  /** "Edit shared steps" link on a shared-steps card. */
  onEditGroup?: (groupId: string) => void;
  /** New ids for Duplicate. */
  makeId?: () => string;
  /** Under the list (Run view tally). */
  footer?: ReactNode;
  /** Scroll the selected row into view when it changes (default true). */
  followSelection?: boolean;
}

let dupSeq = 0;
const defaultId = () => 'd' + Date.now().toString(36) + (dupSeq++).toString(36);

export function StepsPanel(p: StepsPanelProps) {
  const { steps, mode } = p;
  const edit = mode === 'edit';
  const rows = flatRows(steps);
  const n = countRows(steps);
  const listRef = useRef<HTMLDivElement>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<{ id: string; over?: string; edge?: 'before' | 'after' } | null>(null);
  const seen = useRef<Set<string> | null>(null);
  // Rows that weren't there on the previous render fade up (not on first paint).
  const fresh = new Set<string>();
  if (seen.current) rows.forEach(r => { if (!seen.current!.has(r.step.id)) fresh.add(r.step.id); });
  useEffect(() => { seen.current = new Set(rows.map(r => r.step.id)); });

  useEffect(() => {
    if (p.followSelection === false) return;
    const id = p.selectedId ?? p.checkingId;
    if (!id) return;
    listRef.current?.querySelector(`[data-step-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [p.selectedId, p.checkingId, p.followSelection]);

  const change = (next: Step[]) => p.onChange?.(next);
  const toggleGroup = (id: string) => setOpenGroups(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const onDragStart = (id: string) => (e: DragEvent) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); setDrag({ id }); };
  const onDragOver = (id: string) => (e: DragEvent) => {
    if (!drag) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const edge = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
    if (drag.over !== id || drag.edge !== edge) setDrag({ ...drag, over: id, edge });
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    if (drag?.over && drag.over !== drag.id) change(drag.edge === 'before' ? moveBefore(steps, drag.id, drag.over) : moveAfter(steps, drag.id, drag.over));
    setDrag(null);
  };

  const openLoop = p.openLoopId ? rows.find(r => r.step.id === p.openLoopId) : undefined;
  const lastInOpenLoop = openLoop ? lastRowOfLoop(rows, openLoop) : undefined;

  const items: ReactNode[] = [];
  rows.forEach(r => {
    items.push(renderRow(r));
    if (edit && openLoop && lastInOpenLoop === r.step.id) {
      items.push(<NextSlot key="next-loop" depth={openLoop.depth + 1} />);
      items.push(
        <button key="done-repeating" type="button" className="loop-done" style={{ marginLeft: 22 * (openLoop.depth + 1) }} onClick={p.onCloseLoop}>
          <Icon name="check" size={18} />Done repeating
        </button>,
      );
    }
  });

  function renderRow(r: RowInfo) {
    const s = r.step;
    const selected = p.selectedId === s.id;
    const isGroup = s.action === 'group';
    const children = isGroup ? p.groupSteps?.(s) : undefined;
    const groupOpen = isGroup && (openGroups.has(s.id) || (edit && selected));
    const status = p.statuses?.[s.id];
    let note: ReactNode = p.notes?.[s.id] ?? stepNote(s, { range: r.range });
    let tone: 'muted' | 'failed' | 'passed' | 'accent' = status === 'failed' ? 'failed' : 'muted';
    if (edit && p.rerecordingId === s.id) { note = 'Re-recording: do this step again on the page'; tone = 'accent'; }
    else if (edit && s.rerecorded) { note = 'Re-recorded'; tone = 'passed'; }

    const trailing = isGroup ? (
      <button type="button" className="group-toggle" aria-expanded={groupOpen} aria-label={groupOpen ? 'Hide shared steps' : 'Show shared steps'}
        onClick={e => { e.stopPropagation(); toggleGroup(s.id); }}>
        {children ? `${children.length} steps` : 'Shared'}<Icon name={groupOpen ? 'expand_less' : 'expand_more'} size={18} />
      </button>
    ) : edit && selected && !isGroup ? <Icon name="expand_less" size={20} className="step-chev" /> : null;

    const expanded = (
      <>
        {groupOpen && <GroupChildren number={r.number} steps={children} onEdit={p.onEditGroup && s.groupId ? () => p.onEditGroup!(s.groupId!) : undefined} />}
        {edit && selected && (
          <StepEditor step={s}
            onChange={patch => change(updateStep(steps, s.id, patch))}
            onRerecord={s.action !== 'loop' && s.action !== 'group' && p.onRerecord ? () => p.onRerecord!(s.id) : undefined}
            onDuplicate={() => { const d = duplicateStep(steps, s.id, p.makeId ?? defaultId); change(d.steps); if (d.copyId) p.onSelect?.(d.copyId); }}
            onDelete={() => { change(removeStep(steps, s.id)); p.onSelect?.(null); }} />
        )}
      </>
    );

    return (
      <StepRow key={s.id} step={s} number={r.number} depth={r.depth} selected={selected} status={status}
        note={note} noteTone={tone} checking={p.checkingId === s.id} trailing={trailing} fresh={fresh.has(s.id)}
        onSelect={p.onSelect ? () => p.onSelect!(selected && edit ? null : s.id) : undefined}
        onMove={edit ? d => change(moveBy(steps, s.id, d)) : undefined}
        dropEdge={drag && drag.over === s.id && drag.id !== s.id ? drag.edge : null}
        headProps={edit ? { draggable: true, onDragStart: onDragStart(s.id), onDragOver: onDragOver(s.id), onDrop, onDragEnd: () => setDrag(null) } : undefined}>
        {groupOpen || (edit && selected) ? expanded : null}
      </StepRow>
    );
  }

  return (
    <aside className="steps-panel" aria-label={p.title ?? 'Steps'}>
      <div className="steps-head"><h2>{p.title ?? 'Steps'}</h2><span>{p.countText ?? `${n} ${n === 1 ? 'step' : 'steps'}`}</span></div>
      <div className="steps-list" ref={listRef} onDragOver={e => { if (drag) e.preventDefault(); }}>
        {items}
        {edit && !openLoop && <NextSlot depth={0} />}
      </div>
      {p.footer}
    </aside>
  );
}

function lastRowOfLoop(rows: RowInfo[], loop: RowInfo): string {
  const i = rows.indexOf(loop);
  let last = loop.step.id;
  for (let k = i + 1; k < rows.length && rows[k].depth > loop.depth; k++) last = rows[k].step.id;
  return last;
}

function NextSlot({ depth }: { depth: number }) {
  return <div className="step-next" style={depth ? { marginLeft: 22 * depth } : undefined}><Icon name="add" size={18} />Next step goes here</div>;
}

function GroupChildren({ number, steps, onEdit }: { number: number; steps?: Step[]; onEdit?: () => void }) {
  return (
    <div className="group-children">
      {steps === undefined && <div className="group-child faint">Loading…</div>}
      {steps?.map((c, i) => (
        <div key={c.id} className="group-child"><span className="gc-n">{number}.{i + 1}</span><Icon name={stepIcon(c)} size={16} /><span className="ellipsis">{c.label}</span></div>
      ))}
      <div className="group-foot">
        <Icon name="lock" size={14} />Read-only here
        <div className="grow" />
        {onEdit && <button type="button" className="group-edit" onClick={e => { e.stopPropagation(); onEdit(); }}>Edit shared steps</button>}
      </div>
    </div>
  );
}

const TARGETED = new Set<Step['action']>(['click', 'doubleClick', 'longClick', 'rightClick', 'hover', 'swipe', 'scroll', 'drag', 'write', 'waitUntil', 'checkpoint', 'upload']);

function StepEditor({ step, onChange, onRerecord, onDuplicate, onDelete }: {
  step: Step; onChange: (patch: Partial<Step>) => void; onRerecord?: () => void; onDuplicate: () => void; onDelete: () => void;
}) {
  const isLoop = step.action === 'loop';
  const isGroup = step.action === 'group';
  return (
    <div className="step-edit" onClick={e => e.stopPropagation()}>
      {isLoop && (
        <label className="loop-count">
          Repeat
          <input className="input" type="number" min={1} max={100} value={step.count ?? 2} aria-label="Repeat count"
            onChange={e => { const c = Math.max(1, Math.min(100, Number(e.target.value) || 1)); onChange({ count: c, label: `Repeat ${c} times` }); }} />
          times
        </label>
      )}
      {!isLoop && !isGroup && (TARGETED.has(step.action) || step.target) && (
        <div className="look-for">
          <label className="look-label" htmlFor={'look-' + step.id}><Icon name="auto_awesome" size={15} />What to look for</label>
          <LookFor id={'look-' + step.id} value={step.target ?? ''} onCommit={v => onChange({ target: v || undefined })} />
        </div>
      )}
      <div className="step-actions">
        {onRerecord && <button type="button" className="step-btn" onClick={onRerecord}><Icon name="replay" size={17} />Re-record</button>}
        <button type="button" className="step-btn" onClick={onDuplicate}><Icon name="content_copy" size={17} />Duplicate</button>
        <button type="button" className="step-btn danger icon-only step-delete" onClick={onDelete} aria-label="Delete step" title="Delete step"><Icon name="delete" size={17} /></button>
      </div>
    </div>
  );
}

/** Editable "What to look for": grows with its text, saves on blur or Enter. */
function LookFor({ id, value, onCommit }: { id: string; value: string; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }, [v]);
  return (
    <textarea id={id} ref={ref} className="look-text" rows={1} value={v} placeholder="Describe it in plain words, for example: Done button in the dialog"
      onChange={e => setV(e.target.value)}
      onBlur={() => { if (v.trim() !== value) onCommit(v.trim()); }}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
        if (e.key === 'Escape') { setV(value); e.stopPropagation(); }
      }} />
  );
}

/** macOS Reduce motion (README "Motion": everything off). */
function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

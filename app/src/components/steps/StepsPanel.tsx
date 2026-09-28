// The steps panel (380 px, right side). Edit mode (Recorder, Shared steps editor): the
// selected step expands in place with What to look for, What should happen, one row of actions
// (Play this step, Play to here, Re-record) and a ⋯ menu (Edit, Duplicate, Add a step after, Delete);
// a "+" between steps adds one there;
// drag or Alt + arrow keys reorder; loops indent their steps and, while open, end with a
// "Done repeating" chip. Run mode (Run view, Report): read-only rows with run statuses.
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import type { Expect, Generated, SampleFile, Step } from '../../data/types';
import { GENERATED, SAMPLES } from '../../engine/labels';
import { Button, Icon, Menu } from '../ui';
import { StepRow, type RowStatus } from './StepRow';
import { defaultLabel, stepIcon, stepNote } from './stepText';
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
  /** Replaces a status word, e.g. "Clicking…" on the step being recorded. */
  statusTexts?: Record<string, string>;
  /** Edit mode: new steps go after this step ("Next step goes here" moves there), else at the end. */
  insertAfterId?: string | null;
  /** Edit mode: steps not played since a step was inserted before them. */
  unplayedIds?: Set<string>;
  /** Edit mode: "Play to here" and "Add a step after this one" on a step. */
  onPlayTo?: (id: string) => void;
  onAddAfter?: (id: string) => void;
  /** Edit mode: "Play this step" (just this one, on the page as it is). */
  onPlayStep?: (id: string) => void;
  /** Edit mode: a step was edited; `affectsPage` when what it does to the page changed (its text, address…). */
  onEdited?: (id: string, affectsPage: boolean) => void;
  /** Saved secret names, for editing a Write step. */
  secretNames?: string[];
  /** A run is going: the list is read-only until it ends. */
  locked?: boolean;
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
  // Typed values written into a masked field, shown for now (the eye).
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
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
  const insertAt = edit && p.insertAfterId ? rows.find(r => r.step.id === p.insertAfterId) : undefined;
  // While a test plays, where the next step goes isn't known yet: no marker, no "+".
  const marker = edit && !p.locked;
  rows.forEach(r => {
    items.push(renderRow(r));
    if (marker && insertAt && insertAt.step.id === r.step.id) items.push(<NextSlot key="next-here" depth={r.depth} />);
    else if (marker && p.onAddAfter) items.push(
      <button key={'add-' + r.step.id} type="button" className="step-add-here" style={r.depth ? { marginLeft: 22 * r.depth } : undefined}
        aria-label={`Add a step here, after step ${r.number}`} title="Add a step here" onClick={() => p.onAddAfter!(r.step.id)}>
        <Icon name="add" size={16} />
      </button>,
    );
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
    const status = p.statuses?.[s.id] ?? (edit && p.checkingId === s.id ? 'running' : undefined);
    // The step being recorded can't be edited yet: it expands once it is added.
    const editable = !(edit && p.checkingId === s.id) && !p.locked;
    let note: ReactNode = p.notes?.[s.id] ?? stepNote(s, { range: r.range });
    let tone: 'muted' | 'failed' | 'passed' | 'accent' = status === 'failed' ? 'failed' : 'muted';
    // A step that shows as passed has been played since the change.
    if (edit && p.unplayedIds?.has(s.id) && !p.notes?.[s.id] && status !== 'passed' && status !== 'fixed') note = 'Not played since the change. Run the test to check them.';
    if (edit && p.rerecordingId === s.id) { note = 'Re-recording: do this step again on the page'; tone = 'accent'; }
    else if (edit && s.rerecorded) { note = 'Re-recorded'; tone = 'passed'; }

    const masked = s.action === 'write' && s.masked && !!s.text && !s.secretRef;
    const shown = masked && revealed.has(s.id);
    const eye = masked ? (
      <button type="button" className="step-eye" aria-label={shown ? 'Hide the typed text' : 'Show the typed text'} title={shown ? 'Hide the typed text' : 'Show the typed text'}
        onClick={e => { e.stopPropagation(); setRevealed(r => { const n = new Set(r); if (n.has(s.id)) n.delete(s.id); else n.add(s.id); return n; }); }}>
        <Icon name={shown ? 'visibility_off' : 'visibility'} size={17} />
      </button>
    ) : null;
    const trailing0 = isGroup ? (
      <button type="button" className="group-toggle" aria-expanded={groupOpen} aria-label={groupOpen ? 'Hide shared steps' : 'Show shared steps'}
        onClick={e => { e.stopPropagation(); toggleGroup(s.id); }}>
        {children ? `${children.length} steps` : 'Shared'}<Icon name={groupOpen ? 'expand_less' : 'expand_more'} size={18} />
      </button>
    ) : edit && selected && !isGroup && editable ? <Icon name="expand_less" size={20} className="step-chev" /> : null;
    // The step just added: "Try it" plays it once more from the page before it.
    const tryIt = edit && status === 'added' && p.onPlayStep && !p.locked ? (
      <button type="button" className="step-try" onClick={e => { e.stopPropagation(); p.onPlayStep!(s.id); }}>Try it</button>
    ) : null;
    const trailing = eye || tryIt ? <>{eye}{tryIt}{trailing0}</> : trailing0;

    const expanded = (
      <>
        {groupOpen && <GroupChildren number={r.number} steps={children} onEdit={p.onEditGroup && s.groupId ? () => p.onEditGroup!(s.groupId!) : undefined} />}
        {edit && selected && editable && (
          <StepEditor step={s} number={r.number} secretNames={p.secretNames ?? []}
            onChange={patch => change(updateStep(steps, s.id, patch))}
            onEdit={(patch, affectsPage) => { change(updateStep(steps, s.id, patch)); p.onEdited?.(s.id, affectsPage); }}
            onRerecord={s.action !== 'loop' && s.action !== 'group' && p.onRerecord ? () => p.onRerecord!(s.id) : undefined}
            onPlayTo={p.onPlayTo ? () => p.onPlayTo!(s.id) : undefined}
            onPlayStep={p.onPlayStep && s.action !== 'loop' && s.action !== 'group' ? () => p.onPlayStep!(s.id) : undefined}
            onAddAfter={p.onAddAfter ? () => p.onAddAfter!(s.id) : undefined}
            onDuplicate={() => { const d = duplicateStep(steps, s.id, p.makeId ?? defaultId); change(d.steps); if (d.copyId) p.onSelect?.(d.copyId); }}
            onDelete={() => { change(removeStep(steps, s.id)); p.onSelect?.(null); }} />
        )}
      </>
    );

    return (
      <StepRow key={s.id} step={shown ? { ...s, label: `Write "${s.text}"` } : s} number={r.number} depth={r.depth} selected={selected} status={status}
        note={note} noteTone={tone} checking={p.checkingId === s.id} trailing={trailing} fresh={fresh.has(s.id)} statusText={p.statusTexts?.[s.id]}
        onSelect={p.onSelect ? () => p.onSelect!(selected && edit ? null : s.id) : undefined}
        onMove={edit ? d => change(moveBy(steps, s.id, d)) : undefined}
        dropEdge={drag && drag.over === s.id && drag.id !== s.id ? drag.edge : null}
        headProps={edit ? { draggable: true, onDragStart: onDragStart(s.id), onDragOver: onDragOver(s.id), onDrop, onDragEnd: () => setDrag(null) } : undefined}>
        {groupOpen || (edit && selected && editable) ? expanded : null}
      </StepRow>
    );
  }

  return (
    <aside className="steps-panel" aria-label={p.title ?? 'Steps'}>
      <div className="steps-head"><h2>{p.title ?? 'Steps'}</h2><span>{p.countText ?? `${n} ${n === 1 ? 'step' : 'steps'}`}</span></div>
      <div className="steps-list" ref={listRef} onDragOver={e => { if (drag) e.preventDefault(); }}>
        {items}
        {marker && !openLoop && !insertAt && <NextSlot depth={0} />}
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
/** Steps whose effect replay judges ("What should happen"). */
const JUDGED = new Set<Step['action']>(['click', 'doubleClick', 'longClick', 'rightClick', 'hover', 'swipe', 'scroll', 'drag', 'write', 'navigate', 'upload']);

const EXPECT_CHOICES: { value: Expect | ''; label: string }[] = [
  { value: '', label: 'As recorded' },
  { value: 'newPage', label: 'A new page or screen opens' },
  { value: 'closes', label: 'Something closes or disappears' },
  { value: 'appears', label: 'Something appears' },
  { value: 'changes', label: 'Text or a value changes' },
  { value: 'noChange', label: 'Nothing visible changes' },
];

function StepEditor({ step, number, secretNames, onChange, onEdit, onRerecord, onPlayTo, onPlayStep, onAddAfter, onDuplicate, onDelete }: {
  step: Step; number: number | string; secretNames: string[];
  onChange: (patch: Partial<Step>) => void; onEdit: (patch: Partial<Step>, affectsPage: boolean) => void;
  onRerecord?: () => void; onPlayTo?: () => void; onPlayStep?: () => void; onAddAfter?: () => void;
  onDuplicate: () => void; onDelete: () => void;
}) {
  const isLoop = step.action === 'loop';
  const isGroup = step.action === 'group';
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [noteOpen, setNoteOpen] = useState(!!step.expectNote);
  const items = [
    { label: 'Edit', icon: 'edit', onSelect: () => setEditing(true) },
    { label: 'Duplicate', icon: 'content_copy', onSelect: onDuplicate },
    ...(onAddAfter ? [{ label: 'Add a step after', icon: 'add', onSelect: onAddAfter }] : []),
    'sep' as const,
    { label: 'Delete', icon: 'delete', danger: true, onSelect: () => setConfirmDelete(true) },
  ];
  return (
    <div className="step-edit" onClick={e => e.stopPropagation()}>
      {!isLoop && !isGroup && (TARGETED.has(step.action) || step.target) && (
        <div className="step-field">
          <label className="look-label" htmlFor={'look-' + step.id}><Icon name="auto_awesome" size={15} />What to look for</label>
          <LookFor id={'look-' + step.id} value={step.target ?? ''} onCommit={v => onChange({ target: v || undefined })}
            help="Optional. Helps find it again if the page changes. The dashed box on the page shows where this step acts." />
        </div>
      )}
      {!isLoop && !isGroup && JUDGED.has(step.action) && (
        <div className="step-field">
          <label className="look-label" htmlFor={'expect-' + step.id}><Icon name="check_circle" size={15} />What should happen</label>
          <div className="expect-row">
            <select id={'expect-' + step.id} className="expect-chip" value={step.expect ?? ''} onChange={e => onChange({ expect: (e.target.value || undefined) as Expect | undefined })}>
              {EXPECT_CHOICES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            {!noteOpen && <button type="button" className="expect-add-note" onClick={() => setNoteOpen(true)}>+ note</button>}
          </div>
          {noteOpen && <LookFor id={'note-' + step.id} value={step.expectNote ?? ''} onCommit={v => { onChange({ expectNote: v || undefined }); if (!v) setNoteOpen(false); }}
            placeholder="For example: closes the What's new dialog" autoFocus={!step.expectNote}
            help="Optional. Read by the AI assistant only if this step's check fails, to judge it." />}
        </div>
      )}
      {editing && <StepEditPanel step={step} secretNames={secretNames} onCancel={() => setEditing(false)} onSave={(patch, affects) => { setEditing(false); onEdit(patch, affects); }} />}
      {confirmDelete ? (
        <div className="step-actions step-confirm" role="alert">
          <span className="grow">Delete step {number}?</span>
          <button type="button" className="step-btn danger" onClick={onDelete} autoFocus>Delete</button>
          <button type="button" className="step-btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
        </div>
      ) : (
        <div className="step-actions">
          {onPlayStep && <button type="button" className="step-btn" onClick={onPlayStep}><Icon name="play_arrow" size={17} />Play this step</button>}
          {onPlayTo && <button type="button" className="step-btn" onClick={onPlayTo}><Icon name="play_arrow" size={17} />Play to here</button>}
          {onRerecord && <button type="button" className="step-btn" onClick={onRerecord}><Icon name="replay" size={17} />Re-record</button>}
          <div className="step-more">
            <button type="button" className="step-btn icon-only" aria-label="More for this step" title="More" aria-haspopup="menu" aria-expanded={menu}
              onClick={() => setMenu(m => !m)}><Icon name="more_vert" size={17} /></button>
            <Menu open={menu} onClose={() => setMenu(false)} items={items} label="More for this step" width={200} style={{ right: 0, top: 'calc(100% + 4px)' }} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Edit: the step's own options, like when it was added (floats over the list, never moving the
 * page). Save applies, Esc cancels. Where it acts on the page stays Re-record.
 */
function StepEditPanel({ step, secretNames, onSave, onCancel }: {
  step: Step; secretNames: string[]; onSave: (patch: Partial<Step>, affectsPage: boolean) => void; onCancel: () => void;
}) {
  const [label, setLabel] = useState(step.label);
  const [source, setSource] = useState<'typed' | 'secret' | 'generated'>(step.secretRef ? 'secret' : step.generated ? 'generated' : 'typed');
  const [text, setText] = useState(step.text ?? '');
  const [secretRef, setSecretRef] = useState(step.secretRef ?? secretNames[0] ?? '');
  const [generated, setGenerated] = useState<Generated>(step.generated ?? 'uniqueName');
  const [seconds, setSeconds] = useState(Math.round((step.durationMs ?? 2000) / 1000));
  const [maxWait, setMaxWait] = useState(Math.round((step.timeoutMs ?? 10000) / 1000));
  const [target, setTarget] = useState(step.target ?? '');
  const [url, setUrl] = useState(step.url ?? '');
  const [sample, setSample] = useState<SampleFile>(step.sample ?? 'pdf');
  const [count, setCount] = useState(step.count ?? 2);
  const a = step.action;

  function save() {
    const patch: Partial<Step> = {};
    let affects = false;
    if (a === 'write') {
      const was = { text: step.text, secretRef: step.secretRef, generated: step.generated };
      const now = source === 'typed' ? { text, secretRef: undefined, generated: undefined }
        : source === 'secret' ? { text: undefined, secretRef: secretRef || undefined, generated: undefined }
        : { text: undefined, secretRef: undefined, generated };
      Object.assign(patch, now);                                   // `masked` stays as recorded
      affects = was.text !== now.text || was.secretRef !== now.secretRef || was.generated !== now.generated;
    } else if (a === 'waitFor') {
      patch.durationMs = Math.max(1, seconds) * 1000; affects = patch.durationMs !== step.durationMs;
      patch.label = defaultLabel({ ...step, ...patch } as Step);
      onSave(patch, affects);
      return;
    }
    else if (a === 'waitUntil') { patch.target = target || undefined; patch.timeoutMs = Math.max(1, maxWait) * 1000; }
    else if (a === 'navigate' && (step.nav ?? 'url') === 'url') {
      const u = /^[a-z]+:\/\//i.test(url.trim()) ? url.trim() : 'https://' + url.trim();
      patch.url = u; affects = u !== step.url;
    } else if (a === 'upload' && !step.file) { patch.sample = sample; affects = sample !== step.sample; }
    else if (a === 'loop') { patch.count = Math.max(1, Math.min(100, count)); affects = patch.count !== step.count; }
    // A name left as it was follows what the step now does.
    const auto = label.trim() === step.label ? defaultLabel({ ...step, ...patch } as Step) : label.trim();
    patch.label = label.trim() === step.label && (affects || a === 'loop') ? auto : (label.trim() || step.label);
    onSave(patch, affects);
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') { e.preventDefault(); save(); }
  };
  return (
    <div className="step-editpanel" role="dialog" aria-label="Edit step" onKeyDown={onKey}>
      {/* A seconds wait only waits: its seconds are all there is to it (its name follows them). */}
      {a !== 'waitFor' && <label className="ep-row">Name<input className="input" value={label} autoFocus onChange={e => setLabel(e.target.value)} /></label>}
      {a === 'write' && <>
        <div className="ep-chips" role="radiogroup" aria-label="What to write">
          {([['typed', 'Typed text'], ['secret', 'Saved secret'], ['generated', 'Generated']] as const).map(([v, l]) => (
            <button key={v} type="button" role="radio" aria-checked={source === v} className={'rec-chip' + (source === v ? ' on' : '')} onClick={() => setSource(v)}>{l}</button>
          ))}
        </div>
        {source === 'typed' && <label className="ep-row">Text<input className="input" value={text} onChange={e => setText(e.target.value)} type={step.masked ? 'password' : 'text'} /></label>}
        {source === 'secret' && <label className="ep-row">Saved secret<select className="input" value={secretRef} onChange={e => setSecretRef(e.target.value)}>
          {secretNames.length === 0 && <option value="">No saved secrets on this Mac</option>}
          {secretNames.map(n => <option key={n} value={n}>{n}</option>)}</select></label>}
        {source === 'generated' && <label className="ep-row">Value<select className="input" value={generated} onChange={e => setGenerated(e.target.value as Generated)}>
          {(Object.keys(GENERATED) as Generated[]).map(g => <option key={g} value={g}>{GENERATED[g]}</option>)}</select></label>}
      </>}
      {a === 'waitFor' && <label className="ep-row">Seconds<input className="input" type="number" min={1} max={600} value={seconds} autoFocus onChange={e => setSeconds(Number(e.target.value) || 1)} /></label>}
      {a === 'waitUntil' && <>
        <label className="ep-row">What to wait for<input className="input" value={target} onChange={e => setTarget(e.target.value)} /></label>
        <label className="ep-row">Maximum wait, seconds<input className="input" type="number" min={1} max={600} value={maxWait} onChange={e => setMaxWait(Number(e.target.value) || 1)} /></label>
      </>}
      {a === 'navigate' && (step.nav ?? 'url') === 'url' && <label className="ep-row">Address<input className="input mono" value={url} onChange={e => setUrl(e.target.value)} /></label>}
      {a === 'upload' && (step.file ? <div className="ep-row faint">Uploads {step.file}. Re-record it to pick another file.</div> : (
        <div className="ep-chips" role="radiogroup" aria-label="Sample file">
          {(Object.keys(SAMPLES) as SampleFile[]).map(k => (
            <button key={k} type="button" role="radio" aria-checked={sample === k} className={'rec-chip' + (sample === k ? ' on' : '')} onClick={() => setSample(k)}>{SAMPLES[k]}</button>
          ))}
        </div>
      ))}
      {a === 'loop' && <label className="ep-row">Repeat, times<input className="input" type="number" min={1} max={100} value={count} onChange={e => setCount(Number(e.target.value) || 1)} /></label>}
      <div className="ep-actions">
        <span className="faint grow">Where it acts on the page: Re-record.</span>
        <Button onClick={onCancel}>Cancel</Button>
        <Button kind="primary" onClick={save}>Save</Button>
      </div>
    </div>
  );
}

/** Editable "What to look for": grows with its text, saves on blur or Enter. */
function LookFor({ id, value, onCommit, help, placeholder, autoFocus }: {
  id: string; value: string; onCommit: (v: string) => void; help?: string; placeholder?: string; autoFocus?: boolean;
}) {
  const [v, setV] = useState(value);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => setV(value), [value]);
  useEffect(() => { const el = ref.current; if (el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; } }, [v]);
  // One line; the helper text shows only while editing.
  return (<>
    <textarea id={id} ref={ref} className="look-text" rows={1} value={v} autoFocus={autoFocus}
      placeholder={placeholder ?? 'Describe it in plain words, for example: Done button in the dialog'}
      onChange={e => setV(e.target.value)} onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); if (v.trim() !== value) onCommit(v.trim()); }}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
        if (e.key === 'Escape') { setV(value); e.stopPropagation(); }
      }} />
    {help && focused && <div className="look-help">{help}</div>}
  </>);
}

/** macOS Reduce motion (README "Motion": everything off). */
function reducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

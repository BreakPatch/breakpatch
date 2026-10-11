// The steps of a story, floating over the page above the add step bar (README "Add step bar":
// what comes and goes floats; the page never moves). One line for the step being asked about,
// the whole list on demand, and Edit for the current step. Confirm, Try again and Skip for a
// step that was found are on the AI bar under it (AddStepBar). An imported script's steps are
// learned the same way, by themselves until one isn't found (Pause and Go on switch that).
import { useEffect, useState } from 'react';
import type { Generated } from '../../data/types';
import { GENERATED_CHOICES } from '../../engine/labels';
import { secretNamesHere } from '../../lib/secretScope';
import { Button, ChipSelect, Icon } from '../../components/ui';
import { CAREFUL_NOTE, leftOutText, planDoneText, planHead, planNeeds, type PlanItem, type WalkStep } from './plan';
import type { Recorder } from './useRecorder';
import { isHttpAddress } from '../../lib/calls';
import { withScheme } from '../app/TestDetailsDialog';

const STATE_ICON = { done: 'check_circle', skipped: 'block', todo: 'radio_button_unchecked' } as const;
/** The longest wait a story's step has (engine plan.MAX_WAIT_S). */
const MAX_WAIT_S = 60;

export function PlanCard({ rec }: { rec: Recorder }) {
  const [open, setOpen] = useState(false);
  const run = rec.plan;
  if (!run) return null;
  const cur = run.steps[run.index];
  const asking = rec.ai.state !== 'idle' && rec.ai.plan === run.index;
  const waiting = !!cur && !asking && !rec.planEditing && !rec.busy;
  const script = run.source === 'script';
  return (
    <div className="rec-ai rec-plan" role="region" aria-label={script ? 'Steps from your script' : 'Steps from your story'}>
      <div className="rec-plan-head">
        <Icon name={script ? 'upload_file' : 'auto_awesome'} size={20} className="rec-ai-icon" />
        <div className="grow rec-plan-title">
          {cur ? <><span className="faint">{planHead(run)}</span><span className="rec-plan-now">{rec.planText(cur)}</span></>
            : <span className="rec-plan-now">{planDoneText(run)}</span>}
        </div>
        {script && cur && (run.auto
          ? <button type="button" className="rec-ai-link" onClick={() => rec.setPlanAuto(false)} title="Ask before each step">Pause</button>
          : <button type="button" className="rec-ai-link" onClick={() => rec.setPlanAuto(true)} title="Do each step as soon as it's found">Go on by itself</button>)}
        <button type="button" className="rec-ai-link" aria-expanded={open} onClick={() => setOpen(o => !o)}>{open ? 'Hide steps' : 'All steps'}</button>
        {cur ? <button type="button" className="rec-ai-link" onClick={rec.stopPlan}>Stop</button>
          : <Button kind="primary" onClick={rec.stopPlan}>Done</Button>}
      </div>
      {cur?.careful && !asking && <div className="rec-plan-careful" role="note"><Icon name="warning" size={16} />{CAREFUL_NOTE}</div>}
      {(run.note || leftOutText(run)) && run.index === 0 && !open && (
        <div className="rec-plan-note faint">{[run.note, leftOutText(run)].filter(Boolean).join(' ')}</div>
      )}
      {open && (
        <ol className="rec-plan-list">
          {run.steps.map((s, i) => (
            <li key={i} className={'rec-plan-item ' + s.state + (i === run.index ? ' current' : '')} aria-current={i === run.index ? 'step' : undefined}>
              <Icon name={i === run.index && s.state === 'todo' ? 'arrow_forward' : STATE_ICON[s.state]} size={16} />
              <span className="grow">{rec.planText(s)}</span>
              {s.state === 'skipped' && <span className="faint">Skipped</span>}
              {s.careful && <Icon name="warning" size={16} className="rec-plan-warn" label="May delete, pay for or send something" />}
              {s.check && <span className="faint" title="These words come from the script's code: it asks before this step">Check</span>}
            </li>
          ))}
        </ol>
      )}
      {cur && rec.planEditing && <PlanEdit key={run.index} step={cur} rec={rec} from={run.source} />}
      {waiting && (
        <div className="rec-plan-actions">
          <Button kind="primary" icon="search" onClick={rec.retryPlanStep}>Find it</Button>
          <Button onClick={rec.openPlanEdit}>Edit</Button>
          <Button onClick={rec.skipPlanStep}>Skip</Button>
        </div>
      )}
    </div>
  );
}

type Source = 'typed' | 'secret' | 'generated';

/** Edit the current step: what to look for, and for a typing step what it types. */
function PlanEdit({ step, rec, from }: { step: PlanItem; rec: Recorder; from?: 'story' | 'script' }) {
  const needs = planNeeds(step, from);
  const [target, setTarget] = useState(step.target ?? '');
  const [source, setSource] = useState<Source>(step.secretRef || step.needs === 'secret' ? 'secret' : step.generated ? 'generated' : 'typed');
  const [text, setText] = useState(step.text ?? '');
  const [secretRef, setSecretRef] = useState(step.secretRef ?? '');
  const [generated, setGenerated] = useState<Generated>(step.generated ?? 'uniqueName');
  const [url, setUrl] = useState(step.url ?? '');
  const [seconds, setSeconds] = useState(String(step.seconds ?? 2));
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => { void secretNamesHere().then(n => { setNames(n); setSecretRef(r => r || n[0] || ''); }).catch(() => setNames([])); }, []);
  const write = step.action === 'write', go = step.action === 'navigate' && (!step.nav || step.nav === 'url'), wait = step.action === 'waitFor';
  const needsTarget = step.action !== 'write' && step.action !== 'scroll' && step.action !== 'navigate' && step.action !== 'switchTab' && !wait;
  const address = withScheme(url.trim());
  const secs = Number(seconds);
  const ok = (!needsTarget || !!target.trim()) && (!write || (source === 'typed' ? text !== '' : source === 'secret' ? !!secretRef : true))
    && (!go || isHttpAddress(address)) && (!wait || (Number.isInteger(secs) && secs >= 1 && secs <= MAX_WAIT_S));
  const save = () => {
    if (!ok) return;
    const patch: Partial<WalkStep> = go ? { url: address } : wait ? { seconds: secs } : { target: target.trim() || undefined };
    if (write) Object.assign(patch, source === 'typed' ? { text } : source === 'secret' ? { secretRef } : { generated });
    rec.editPlanStep(patch);
  };
  return (
    <form className="rec-plan-edit" aria-label="Edit this step" onSubmit={e => { e.preventDefault(); save(); }}>
      {needs && <div className="rec-plan-needs" role="status"><Icon name="info" size={16} />{needs}</div>}
      {step.action !== 'navigate' && step.action !== 'waitFor' && step.action !== 'switchTab' && (
        <label className="rec-plan-field">{write ? 'Field to type into' : step.action === 'checkpoint' || step.action === 'waitUntil' ? 'What should show' : 'What to find'}
          <input className="rec-num rec-plan-input" value={target} autoFocus={!needs} placeholder={write ? 'The field that has the focus' : undefined}
            onChange={e => setTarget(e.target.value)} />
        </label>
      )}
      {go && (
        <label className="rec-plan-field">Address
          <input className="rec-num rec-plan-input" value={url} autoFocus placeholder="https://app.example.com" spellCheck={false} autoCapitalize="off"
            onChange={e => setUrl(e.target.value)} />
        </label>
      )}
      {wait && (
        <label className="rec-plan-field">Seconds to wait
          <input className="rec-num rec-plan-input" type="number" min={1} max={MAX_WAIT_S} step={1} value={seconds} autoFocus
            onChange={e => setSeconds(e.target.value)} />
        </label>
      )}
      {write && (
        <div className="rec-plan-field">
          <div className="rec-chips" role="radiogroup" aria-label="What to type">
            {([['typed', 'Typed text'], ['secret', 'Saved secret'], ['generated', 'Generated']] as const).map(([v, l]) => (
              <button key={v} type="button" role="radio" aria-checked={source === v} className={'rec-chip' + (source === v ? ' on' : '')} onClick={() => setSource(v)}>{l}</button>
            ))}
          </div>
          {source === 'typed' && <input className="rec-num rec-plan-input" aria-label="Text to type" value={text} autoFocus={!!needs} onChange={e => setText(e.target.value)} />}
          {source === 'secret' && (names.length
            ? <ChipSelect label="Saved secret" value={secretRef} onChange={setSecretRef} options={names.map(v => ({ value: v, label: v }))} />
            : <span className="faint">No saved secrets yet. Add one in Settings, Saved secrets.</span>)}
          {source === 'generated' && <ChipSelect<Generated> label="Generated value" value={generated} onChange={setGenerated} options={GENERATED_CHOICES} />}
        </div>
      )}
      <div className="rec-plan-actions">
        <Button kind="primary" type="submit" disabled={!ok}>{needsTarget || (write && target.trim()) ? 'Find it' : 'Use this'}</Button>
        <Button onClick={rec.skipPlanStep}>Skip</Button>
        {!needs && <button type="button" className="rec-ai-link" onClick={rec.closePlanEdit}>Cancel</button>}
      </div>
    </form>
  );
}

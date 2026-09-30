// The right side of the report: the selected step's heading, expected vs what was on screen,
// what to try and the actions. A fixed step shows old and new position; accepting it is the
// edition's slot (Team: Accept new position, Dismiss).
import { useNavigate } from 'react-router-dom';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Run, Step, StepRun, Test } from '../../data/types';
import { applyStep, LiveView, replay, type LiveMarker, type SampleState } from '../../components/live';
import { countRows, stepsBefore } from '../../components/steps';
import { Button, CopyButton, Icon } from '../../components/ui';
import { clock } from '../../components/common/format';
import { isTauri } from '../../platform';
import { edition } from '../../edition';
import { demoSeen, isDemo, targetBox } from '../run/demo';
import { reasonAdvice } from '../run/reasons';
import { issueContent } from './issueText';
import { copyDetails, detailKind, detailText, expectLabel, fixBoxes, showsScreens, systemNote } from './reportData';

const { reportFixActions: FixActions, reportFailActions: FailActions } = edition.slots;

function shotUrl(path: string | undefined): string | undefined {
  if (!path) return undefined;
  if (/^(data|https?|blob|asset):/.test(path)) return path;
  return isTauri() ? convertFileSrc(path) : undefined;
}

function hms(ts: number) { const d = new Date(ts); return `${clock(ts)}:${String(d.getSeconds()).padStart(2, '0')}`; }

export interface ReportDetailProps {
  run: Run;
  test: Test | undefined;
  /** Steps as the run tested them. */
  steps: Step[];
  step: Step | undefined;
  stepRun: StepRun | undefined;
  /** "6", or "2.3" inside a shared-steps card. */
  number: string;
  /** The shared-steps card the step sits in, if any. */
  groupId?: string;
  appName: string;
}

export function ReportDetail({ run, test, steps, step, stepRun, number, groupId, appName }: ReportDetailProps) {
  const navigate = useNavigate();
  const vp = test?.viewport ?? { width: 1440, height: 900 };
  if (!step) {
    const ok = run.result === 'pass';
    return (
      <div className="rp-detail">
        <div className="rp-heading">
          <Icon name={ok ? 'check_circle' : 'cancel'} size={28} className={ok ? 'run-tone-passed' : 'run-tone-failed'} />
          <div className="rp-heading-main">
            <div className="rp-headline">{ok ? `All ${countRows(steps)} steps passed` : 'This run failed'}</div>
            <div className="rp-body">{ok ? 'Nothing needs a look. Pick a step on the left to see it.' : "The step that failed isn't in this version of the test any more."}</div>
          </div>
        </div>
      </div>
    );
  }

  const kind = detailKind(stepRun);
  const canAccept = !!FixActions;
  const { headline, body } = detailText(kind, step, stepRun, canAccept);
  const icon = { failed: 'cancel', stopped: 'block', fixed: 'auto_fix_high', passed: 'check_circle', notRun: 'block' }[kind];
  const tone = { failed: 'failed', stopped: 'muted', fixed: 'fixed', passed: 'passed', notRun: 'muted' }[kind];

  // Demo: the sample page before the step (expected) and at the failure (seen).
  const demo = isDemo();
  const before: SampleState | undefined = demo ? replay(stepsBefore(steps, step.id), vp) : undefined;
  const seen: SampleState | undefined = demo && before
    ? demoSeen.get(run.id) ?? (stepRun?.reason === 'targetNotFound' || stepRun?.reason === 'healFailed' ? { ...before, dialog: false, focus: null, name: '' } : applyStep(before, step, vp))
    : undefined;
  const shot = shotUrl(stepRun?.screenshotPath);
  const box = targetBox(step, vp);
  const expectMarkers: LiveMarker[] = box ? [{ kind: 'locked', box, n: Number(number.split('.')[0]) || undefined, label: expectLabel(step) }] : [];
  const seenMarkers: LiveMarker[] = box ? [{ kind: 'failed', box, label: 'Expected here' }] : [];
  const hasPicture = demo || !!shot;
  const rerecordHere = !groupId;

  const shotView = (markers: LiveMarker[], state: SampleState | undefined, cls = '') => (
    hasPicture
      ? <div className={`rp-shot ${cls}`}><LiveView address="" viewport={vp} readOnly hideBar hideZoom pad={0} markers={markers} sampleState={state} image={demo ? undefined : shot} /></div>
      : <div className={`rp-shot rp-noshot ${cls}`}><Icon name="hide_image" size={22} />No screenshot for this run</div>
  );

  let content = null;
  if (kind === 'failed' && showsScreens(stepRun)) {
    content = (
      <div className="rp-compare">
        <div className="rp-col">
          <div className="rp-col-label"><Icon name="check_circle" size={18} className="run-tone-passed" />Expected</div>
          {shotView(expectMarkers, before)}
          <div className="rp-caption">{demo ? 'When the step was recorded' : 'Where the step was recorded, on this run\'s screen'}</div>
        </div>
        <div className="rp-col">
          <div className="rp-col-label"><Icon name="cancel" size={18} className="run-tone-failed" />What was on screen</div>
          {shotView(seenMarkers, seen, 'seen')}
          <div className="rp-caption">This run, {hms(run.startedAt + run.durationMs)}</div>
        </div>
      </div>
    );
  } else if (kind === 'fixed' && stepRun?.oldAt && stepRun.newAt) {
    const b = fixBoxes(step, stepRun.oldAt, stepRun.newAt);
    content = shotView([{ kind: 'old', box: b.old, label: 'Old position' }, { kind: 'new', box: b.now, label: 'New position' }], before, 'rp-shot-wide');
  } else if (kind === 'passed' && (demo || shot)) {
    content = shotView(expectMarkers, before, 'rp-shot-wide');
  }

  const otherSystem = kind === 'failed' ? systemNote(run, stepRun) : null;
  const failedActions = kind === 'failed' && (
    <>
      {otherSystem && <div className="rp-try" role="note"><div className="rp-try-title">Recorded on another system</div><div className="rp-try-text">{otherSystem}</div></div>}
      <div className="rp-try"><div className="rp-try-title">What to try</div><div className="rp-try-text">{reasonAdvice(stepRun?.reason)}</div></div>
      <div className="rp-actions">
        {stepRun?.reason === 'secretMissing'
          ? <Button kind="primary" size="lg" icon="key" onClick={() => navigate('/settings/secrets')}>Open Saved secrets</Button>
          : rerecordHere
            ? <Button kind="primary" size="lg" icon="replay" onClick={() => navigate(`/apps/${run.appId}/tests/${run.testId}/record?rerecord=${encodeURIComponent(step.id)}`)}>Re-record this step</Button>
            : <Button kind="primary" size="lg" icon="edit" onClick={() => navigate(`/apps/${run.appId}/shared/${groupId}/edit`)}>Edit shared steps</Button>}
        <CopyButton size="lg" label="Copy details" copiedLabel="Copied" text={() => copyDetails(run, step, number, stepRun, appName)} />
        <CopyButton size="lg" label="Copy as Markdown" copiedLabel="Copied" text={() => { const c = issueContent({ run, test, steps, step, stepRun, number, appName }); return `## ${c.title}\n\n${c.markdown}`; }} />
        {FailActions && <FailActions run={run} stepRun={stepRun ?? { stepId: step.id, result: 'failed' }} step={step} test={test} steps={steps} number={number} appName={appName} />}
        {rerecordHere && stepRun?.reason !== 'secretMissing' && <div className="rp-hint">Re-record takes you back to this step with the page as it was.</div>}
      </div>
    </>
  );

  return (
    <div className="rp-detail" key={step.id}>
      <div className="rp-heading">
        <Icon name={icon} size={28} className={`run-tone-${tone}`} />
        <div className="rp-heading-main">
          <div className="rp-stepno">Step {number} · {step.label}</div>
          <div className="rp-headline">{headline}</div>
          <div className="rp-body">{body}</div>
        </div>
      </div>
      {content}
      {failedActions}
      {kind === 'fixed' && FixActions && stepRun && <FixActions run={run} stepRun={stepRun} step={step} test={test} />}
    </div>
  );
}

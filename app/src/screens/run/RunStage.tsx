// The Run view's two panes, shared with the suite run view: the live page with "Clicking here"
// and the status strip on the left, the steps with live statuses and a tally on the right.
import type { ReactNode } from 'react';
import type { Step, Viewport } from '../../data/types';
import { around, LiveView, useSampleState, type LiveMarker } from '../../components/live';
import { StepsPanel } from '../../components/steps';
import { Icon, Skeleton } from '../../components/ui';
import { addressOf } from '../recorder/browserSession';
import { targetName } from './reasons';
import { rowStatus, tally, type RunView } from './runState';
import { numberOf, rowNotes, runStrip, stepCountText, type RunInfo, type Strip } from './strip';
import { targetBox } from './demo';
import { hasFeature } from '../../edition';
import { isTouch } from '../../data/devices';
import './run.css';

const ACTING: Partial<Record<Step['action'], string>> = {
  click: 'Clicking here', doubleClick: 'Double-clicking here', longClick: 'Pressing here', rightClick: 'Right-clicking here', hover: 'Pointing here',
  write: 'Writing here', drag: 'Dragging from here', swipe: 'Swiping here', scroll: 'Scrolling here', checkpoint: 'Checking here', waitUntil: 'Waiting for this', upload: 'Uploading here',
};
/** A phone or tablet test is tapped, not clicked. */
const TOUCH_ACTING: Partial<Record<Step['action'], string>> = { click: 'Tapping here', doubleClick: 'Double-tapping here' };

/** Markers on the page: the current target while running; where it was expected after a failure; old and new position after a fix. */
export function runMarkers(view: RunView, info: RunInfo, vp: Pick<Viewport, 'width' | 'height' | 'device'>): LiveMarker[] {
  if (view.phase === 'running' && view.currentId) {
    const s = info.byId.get(view.currentId);
    const box = s && ACTING[s.action] && view.states[s.id] === 'running' ? targetBox(s, vp) : null;
    const n = Number(numberOf(info, view.currentId).split('.')[0]) || undefined;
    return box ? [{ kind: 'locked', box, n, label: (isTouch(vp) && TOUCH_ACTING[s!.action]) || ACTING[s!.action] }] : [];
  }
  if (view.phase === 'ended' && view.failedId && view.reasons[view.failedId] !== 'stopped') {
    const s = info.byId.get(view.failedId);
    const box = s ? targetBox(s, vp) : null;
    return box ? [{ kind: 'failed', box, label: 'Expected here' }] : [];
  }
  if (view.phase === 'ended') {
    const [id, fix] = Object.entries(view.fixes).find(([k]) => !info.byId.get(k)?.steps) ?? [];
    if (id && fix?.oldAt && fix.newAt) return [{ kind: 'old', box: around(fix.oldAt, 24), label: 'Old position' }, { kind: 'new', box: around(fix.newAt, 24), label: 'New position' }];
  }
  return [];
}

export function StripIcon({ strip, size = 24 }: { strip: Strip; size?: number }) {
  return <Icon name={strip.icon} size={size} className={`run-tone-${strip.tone}${strip.motion === 'spin' ? ' spin' : strip.motion === 'pulse' ? ' anim-pulse' : ' anim-pop'}`} />;
}

export function RunPage({ view, info, startUrl, viewport, strip, stripExtra }: {
  view: RunView; info: RunInfo | null; startUrl?: string; viewport: Pick<Viewport, 'width' | 'height' | 'device'>;
  /** Replaces the strip's words (suite view: "Test · step"). */
  strip?: Strip; stripExtra?: ReactNode;
}) {
  useSampleState();                                   // markers follow what the sample page shows
  const s = strip ?? (info ? runStrip(view, info) : runStrip(view, { byId: new Map(), refs: new Map(), rows: [] }));
  const looking = view.phase === 'running' && view.currentId && view.states[view.currentId] === 'looking' ? info?.byId.get(view.currentId) : undefined;
  return (
    <div className="run-left">
      <LiveView address={addressOf(startUrl)} viewport={viewport} readOnly loading={view.phase === 'starting' || view.phase === 'idle'}
        markers={info ? runMarkers(view, info, viewport) : []} thinking={looking ? `Looking for ${targetName(looking)}…` : null} />
      <div className="run-strip" role="status" aria-live="polite">
        <StripIcon key={s.icon + s.tone} strip={s} />
        <div className="run-strip-main">
          <div className="run-strip-title ellipsis">{s.title}</div>
          <div className="run-strip-text">{s.text}</div>
        </div>
        {stripExtra}
      </div>
    </div>
  );
}

export function RunSteps({ view, info, steps }: { view: RunView; info: RunInfo | null; steps: Step[] | null }) {
  if (!steps || !info) {
    return (
      <aside className="steps-panel" aria-label="Steps" aria-busy>
        <div className="steps-head"><h2>Steps</h2><span /></div>
        <div className="steps-list">{[0, 1, 2, 3, 4].map(i => <div key={i} className="row" style={{ padding: '8px 10px', gap: 10 }}><Skeleton w={18} h={12} /><Skeleton w={30} h={30} r={15} /><Skeleton w={`${50 + (i * 13) % 35}%`} h={14} /></div>)}</div>
      </aside>
    );
  }
  const statuses = Object.fromEntries(Object.entries(view.states).map(([id, st]) => [id, rowStatus(st, view.reasons[id])!]));
  const t = tally(view.states, info.rows, view.reasons);
  const current = view.phase === 'running' ? info.refs.get(view.currentId ?? '')?.rowId ?? null : null;
  return (
    <StepsPanel steps={steps} mode="run" countText={stepCountText(view, info)} statuses={view.phase === 'idle' ? {} : statuses}
      notes={rowNotes(view, info)} selectedId={current} groupSteps={s => s.steps}
      footer={
        <div className="run-tally" aria-label="Tally">
          <span><Icon name="check_circle" size={16} className="run-tone-passed" />{t.passed} passed</span>
          {(hasFeature('autoFix') || t.fixed > 0) && <span><Icon name="auto_fix_high" size={16} className="run-tone-fixed" />{t.fixed} fixed</span>}
          <span><Icon name="cancel" size={16} className="run-tone-failed" />{t.failed} failed</span>
        </div>
      } />
  );
}

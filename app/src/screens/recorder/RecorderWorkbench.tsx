// The recorder layout shared by the Recorder and the Shared steps editor: live browser and
// add step bar on the left, steps panel (380 px) on the right.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Step, StepGroup, Viewport } from '../../data/types';
import { useBackend, useLive } from '../../data/hooks';
import { CheckingPill, LiveView, SavedPill, stepMarker, useSampleState } from '../../components/live';
import { findStep, numberOf, StepsPanel, toTokens, type RowStatus } from '../../components/steps';
import { Skeleton } from '../../components/ui';
import { AddStepBar } from './AddStepBar';
import { secretNamesHere } from '../../lib/secretScope';
import { getEngine } from '../../engine';
import { Icon } from '../../components/ui';
import { FileChooserDialog } from './FileChooserDialog';
import { toolFor } from './actions';
import { isTouch } from '../../data/devices';
import { localId, type Recorder } from './useRecorder';
import './recorder.css';
import { osText, shortcutKeyDown } from '../../lib/osWords';

export function RecorderWorkbench({ rec, appId, address, viewport, allowGroups, loading, onEditGroup, run }: {
  rec: Recorder; appId: string; address: string; viewport: Pick<Viewport, 'width' | 'height' | 'device'>;
  /** Tests can insert shared steps; shared steps can't contain other shared steps. */
  allowGroups: boolean;
  loading?: boolean;
  onEditGroup?: (groupId: string) => void;
  /** The recorder's own Run and Play to here (tests only). */
  run?: {
    running: boolean; statuses: Record<string, RowStatus>; notes: Record<string, string>; footer?: ReactNode;
    onPlayTo: (id: string) => void; onAddAfter: (id: string) => void; onPlayStep: (id: string) => void;
    /** A line floating over the page: Play this step's progress, or a hint with a button. */
    banner?: { text: string; tone?: 'ok' | 'bad'; icon?: string; action?: { label: string; onClick: () => void } } | null;
  };
}) {
  useSampleState();                                      // markers follow what the sample page shows
  const [secretNames, setSecretNames] = useState<string[]>([]);
  useEffect(() => { void secretNamesHere().then(setSecretNames).catch(() => setSecretNames([])); }, []);
  const groupSteps = useGroupSteps(appId, rec.steps);
  const sel = rec.selectedId ? findStep(rec.steps, rec.selectedId) : undefined;
  const marker = sel && rec.ai.state === 'idle' && !run?.running ? stepMarker(sel, numberOf(rec.steps, sel.id), sel.id === rec.busyId ? rec.phaseText ?? undefined : undefined, isTouch(viewport)) : null;
  const pill = rec.checking ? <CheckingPill text={rec.phaseText ?? undefined} /> : rec.savedPill ? <SavedPill key={rec.savedPill} text={rec.savedPill} /> : null;
  // ✋ Use the page: the user works the page directly (nothing recorded). Cmd+E toggles it; not Esc (the page may need it).
  const engineLive = getEngine().liveMode === 'frames';
  const canHand = !loading && engineLive && !run?.running && !rec.busy;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (shortcutKeyDown(e) && e.key.toLowerCase() === 'e' && (canHand || rec.hand)) { e.preventDefault(); void rec.setHand(!rec.hand); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canHand, rec]);
  const handBtn = (
    <button type="button" className={'live-hand-btn' + (rec.hand ? ' on' : '')} aria-pressed={rec.hand} disabled={!canHand && !rec.hand}
      title={osText('Use the page directly, without recording (⌘E)')} onClick={() => void rec.setHand(!rec.hand)}>
      <Icon name="back_hand" size={16} />Use the page
    </button>
  );
  const status = <>{pill}{handBtn}</>;
  const busyStep = rec.busyId ? findStep(rec.steps, rec.busyId) : undefined;
  // While a step records, the page can't take another click (it would land on a page that is changing).
  const blocked = run?.running ? 'The test is playing. Stop it to click the page.'
    : !rec.busy ? null : busyStep ? `Wait for step ${numberOf(rec.steps, busyStep.id)} to finish, then click.` : 'Wait for the last step to finish, then click.';
  const statuses = { ...run?.statuses, ...(rec.addedId && !rec.busy ? { [rec.addedId]: 'added' as const } : {}) };
  const statusTexts = rec.busyId && rec.phaseText ? { [rec.busyId]: rec.phaseText } : undefined;

  const insertGroup = (g: StepGroup, version: number | 'latest') =>
    rec.addLocal({ id: localId('grp'), action: 'group', label: g.name, target: `Shared steps: ${g.name}`, groupId: g.id, groupVersion: version });

  return (
    <div className="rec-body">
      <div className="rec-left">
        <LiveView address={address} viewport={viewport} status={status} tool={loading ? 'none' : toolFor(rec.action)}
          passThrough={rec.hand} onInput={i => { void getEngine().input(i).catch(() => undefined); }}
          onPoint={rec.pagePoint} onDrag={rec.pageDrag} onBox={rec.pageBox} onScroll={rec.pageScroll} blocked={blocked}
          markers={marker ? [marker] : []} candidate={rec.ai.state === 'result' || rec.ai.state === 'proposal' ? rec.ai.box ?? null : null} thinking={rec.thinking} loading={loading} />
        <FileChooserDialog ask={rec.fileAsk} dir={rec.filesDir} onChoose={rec.chooseFile} />
        <FileChooserDialog ask={rec.handAsk} dir={rec.filesDir} onChoose={rec.handChooseFile} />
        <AddStepBar rec={rec} appId={appId} allowGroups={allowGroups} touch={isTouch(viewport)} onInsertGroup={insertGroup} frozen={run?.running ? 'The test is playing in this browser. Stop it, or wait for it to finish, to add steps.'
          : rec.hand ? "Recording is paused while you use the page." : null}
          banner={rec.hand ? { text: "You're using the page directly. Nothing is recorded.", icon: 'back_hand', action: { label: 'Done', onClick: () => void rec.setHand(false) } } : run?.banner ?? null} />
      </div>
      {loading ? (
        <aside className="steps-panel" aria-label="Steps" aria-busy>
          <div className="steps-head"><h2>Steps</h2><span /></div>
          <div className="steps-list">{[0, 1, 2, 3, 4].map(i => <div key={i} className="row" style={{ padding: '8px 10px', gap: 10 }}><Skeleton w={18} h={12} /><Skeleton w={30} h={30} r={15} /><Skeleton w={`${50 + (i * 13) % 35}%`} h={14} /></div>)}</div>
        </aside>
      ) : (
        <StepsPanel steps={rec.steps} mode="edit" selectedId={rec.selectedId} onSelect={id => { if (rec.ai.state !== 'idle') rec.cancelAi(); rec.setSelectedId(id); }}
          onChange={rec.change} onRerecord={rec.startRerecord} rerecordingId={rec.rerecordId} checkingId={rec.busyId} statuses={statuses} statusTexts={statusTexts}
          openLoopId={rec.openLoopId} onCloseLoop={() => rec.setOpenLoopId(null)} groupSteps={groupSteps} onEditGroup={onEditGroup}
          makeId={() => localId('s')} notes={run?.notes} insertAfterId={rec.insertAfterId} unplayedIds={rec.unplayed}
          onPlayTo={run?.onPlayTo} onAddAfter={run?.onAddAfter} onPlayStep={run?.onPlayStep} onEdited={rec.edited} secretNames={secretNames} appUrl={rec.appUrl} locked={run?.running} footer={run?.footer} />
      )}
    </div>
  );
}

/** Resolves the steps inside each shared-steps card from its version (latest = the group's current one). */
function useGroupSteps(appId: string, steps: Step[]) {
  const b = useBackend();
  const { data: groups } = useLive<StepGroup[]>((be, l) => be.stepGroups(appId, l), [appId]);
  const [cache, setCache] = useState<Record<string, Step[]>>({});
  const refs = useMemo(() => {
    const out: { key: string; groupId: string; version: number }[] = [];
    for (const t of toTokens(steps)) {
      if (t.kind !== 'step' || t.step.action !== 'group' || !t.step.groupId) continue;
      const g = groups?.find(x => x.id === t.step.groupId);
      const v = t.step.groupVersion === 'latest' || t.step.groupVersion === undefined ? g?.currentVersion : t.step.groupVersion;
      if (v) out.push({ key: `${t.step.groupId}@${v}`, groupId: t.step.groupId, version: v });
    }
    return out;
  }, [steps, groups]);
  const asked = useRef(new Set<string>());
  useEffect(() => {
    refs.filter(r => !asked.current.has(r.key)).forEach(r => {
      asked.current.add(r.key);
      void b.groupVersion(appId, r.groupId, r.version).then(v => setCache(c => ({ ...c, [r.key]: v?.steps ?? [] })));
    });
  }, [refs, b, appId]);
  return (s: Step) => {
    const g = groups?.find(x => x.id === s.groupId);
    const v = s.groupVersion === 'latest' || s.groupVersion === undefined ? g?.currentVersion : s.groupVersion;
    return v ? cache[`${s.groupId}@${v}`] : undefined;
  };
}

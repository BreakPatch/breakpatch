// Run report (README "4 · Run and report", ui-requirements §5.10): /apps/:appId/runs/:runId,
// ?tab=history for Run history. Overall result and who/where/when on top; the steps on the
// left with the one that needs a look selected; its detail on the right.
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { Run } from '../../data/types';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, Segmented, Skeleton, StatusPill } from '../../components/ui';
import { StepRow, flatRows, type RowStatus } from '../../components/steps';
import { formatWhen, plural } from '../../components/common/format';
import { runBy, runStatus, WHERE } from '../../components/common/runs';
import { hasFeature } from '../../edition';
import { preorder, rowRefs } from '../run/resolve';
import { reasonTitle, passNote, slowNote } from '../run/reasons';
import { focusStep } from '../run/runState';
import { ReportDetail } from './ReportDetail';
import { RunHistory } from './RunHistory';
import { tookText } from './reportData';
import { useReport } from './useReport';
import '../run/run.css';
import './report.css';

const ROW: Record<Run['steps'][number]['result'], RowStatus> = { passed: 'passed', healed: 'fixed', failed: 'failed', notRun: 'notRun' };

export default function ReportScreen() {
  const { appId = '', runId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { run, runs, test, steps, app, missing } = useReport(appId, runId);

  const showHistory = hasFeature('versions') || (runs?.length ?? 0) > 1;
  const tab = params.get('tab') === 'history' && showHistory ? 'history' : 'run';
  const setTab = (t: 'run' | 'history') => setParams(t === 'history' ? { tab: 'history' } : {}, { replace: true });

  const flat = useMemo(() => (steps ? preorder(steps) : []), [steps]);
  const refs = useMemo(() => (steps ? rowRefs(steps) : new Map()), [steps]);
  const byRun = useMemo(() => new Map(run?.steps.map(r => [r.stepId, r]) ?? []), [run]);
  const focus = run && steps ? focusStep(run, flat) : undefined;
  const [sel, setSel] = useState<string | null>(null);
  useEffect(() => { setSel(null); }, [runId]);
  const selId = sel ?? focus?.stepId ?? null;
  const selStep = selId ? flat.find(s => s.id === selId) : undefined;
  const selRef = selId ? refs.get(selId) : undefined;

  const back = () => (location.key !== 'default' ? navigate(-1) : navigate(`/apps/${appId}?tab=runs`));
  const crumb = [app?.name, run?.testName ?? test?.name].filter(Boolean).join(' · ') || ' ';

  if (missing) {
    return (
      <AppFrame back={back} crumb={app?.name} title="Run report">
        <EmptyState icon="search_off" title="This run isn't here any more." text="Only the last run of each test is kept on this Mac. Run the test again for a new report."
          action={<Button kind="primary" onClick={() => navigate(`/apps/${appId}`)}>Back to {app?.name ?? 'the app'}</Button>} />
      </AppFrame>
    );
  }

  const runAgain = () => run && navigate(`/apps/${appId}/tests/${run.testId}/run`);
  const openEditor = () => run && navigate(`/apps/${appId}/tests/${run.testId}/record${selRef && selRef.rowId ? `?step=${encodeURIComponent(selRef.rowId)}` : ''}`);
  const actions = run && (tab === 'history'
    ? <Button kind="primary" icon="play_arrow" onClick={runAgain} disabled={!test}>Run now</Button>
    : <>
        <Button icon="edit" onClick={openEditor} disabled={!test}>Open in editor</Button>
        <Button kind="primary" icon="replay" onClick={runAgain} disabled={!test}>Run again</Button>
      </>);

  const status = run ? runStatus(run) : undefined;
  const meta = run ? [
    { k: 'Took', v: tookText(run.durationMs) },
    { k: 'Run by', v: runBy(run) },
    { k: 'Where', v: WHERE[run.source].label },
    { k: 'Machine', v: run.machine },
    { k: 'When', v: formatWhen(run.startedAt) },
    ...(hasFeature('versions') ? [{ k: 'Version', v: String(run.testVersion) }] : []),
  ] : [];

  return (
    <AppFrame back={back} crumb={crumb} title={tab === 'history' ? 'Run history' : 'Run report'} actions={actions}>
      <div className="rp-head">
        {tab === 'run' ? (
          <>
            {run && status ? <StatusPill status={status} /> : <Skeleton w={140} h={40} r={20} />}
            {run ? meta.map(m => (
              <div key={m.k} className="rp-meta"><div className="rp-meta-k">{m.k}</div><div className="rp-meta-v ellipsis" title={m.v}>{m.v}</div></div>
            )) : [0, 1, 2, 3].map(i => <div key={i} className="rp-meta"><Skeleton w={40} h={11} /><Skeleton w={90} h={14} /></div>)}
          </>
        ) : <div className="rp-count">{runs ? plural(runs.length, 'run') : ' '}</div>}
        <div className="grow" />
        {showHistory && <Segmented<'run' | 'history'> label="Report" value={tab} onChange={setTab} items={[{ value: 'run', label: 'This run' }, { value: 'history', label: 'Run history' }]} />}
      </div>

      {tab === 'history' ? (
        <div className="rp-history-wrap">
          {runs ? <RunHistory runs={runs} currentId={runId} onOpen={r => navigate(`/apps/${appId}/runs/${r.id}`)} /> : <Skeleton h={200} />}
        </div>
      ) : (
        <div className="rp-body-wrap">
          <div className="rp-steps" role="list" aria-label="Steps">
            {!steps || !run ? [0, 1, 2, 3, 4, 5].map(i => <div key={i} className="row" style={{ padding: '8px 10px', gap: 10 }}><Skeleton w={18} h={12} /><Skeleton w={30} h={30} r={15} /><Skeleton w={`${50 + (i * 13) % 35}%`} h={14} /></div>)
              : flatRows(steps).map(r => {
                const sr = byRun.get(r.step.id);
                const st = sr ? (sr.reason === 'stopped' ? 'notRun' : ROW[sr.result]) : undefined;
                const failedChild = r.step.action === 'group' && focus && refs.get(focus.stepId)?.rowId === r.step.id && focus.stepId !== r.step.id;
                const stopped = (failedChild ? focus!.reason : sr?.reason) === 'stopped';
                const note = stopped && sr?.result === 'failed' ? 'You stopped the run here'
                  : sr?.result === 'failed' && !failedChild ? reasonTitle(sr.reason, r.step)
                  : failedChild ? `Step ${refs.get(focus!.stepId)?.number}: ${reasonTitle(focus!.reason, flat.find(s => s.id === focus!.stepId) ?? r.step)}`
                  : passNote(sr) ?? slowNote(sr?.timings, typeof r.number === 'number' && r.number > 1 ? r.number - 1 : undefined);
                return (
                  <div role="listitem" key={r.step.id}>
                    <StepRow step={r.step} number={r.number} depth={r.depth} status={st} note={note} noteTone={sr?.result === 'failed' && !stopped ? 'failed' : 'muted'}
                      selected={selRef?.rowId === r.step.id} onSelect={() => setSel(failedChild ? focus!.stepId : r.step.id)} />
                  </div>
                );
              })}
          </div>
          <div className="rp-main">
            {run && steps
              ? <ReportDetail run={run} test={test ?? undefined} steps={steps} step={selStep} stepRun={selId ? byRun.get(selId) : undefined}
                  number={selRef?.number ?? ''} groupId={selRef && selRef.rowId !== selId ? flat.find(s => s.id === selRef.rowId)?.groupId : undefined} appName={app?.name ?? ''} />
              : <div className="rp-detail"><Skeleton w={220} h={12} /><Skeleton w={360} h={24} /><Skeleton w="70%" h={14} /><Skeleton h={260} /></div>}
          </div>
        </div>
      )}
    </AppFrame>
  );
}

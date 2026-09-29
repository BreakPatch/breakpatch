// Run view (README "4 · Run and report", ui-requirements §5.9): /apps/:appId/tests/:testId/run.
// Starts the run as soon as the test is loaded; the same two panes as the Recorder, nothing
// editable. Stop while running; Run again and See report once it has ended.
import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { App, Test } from '../../data/types';
import { useLive } from '../../data/hooks';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, Icon, useToast } from '../../components/ui';
import { formatDuration } from '../../components/common/format';
import { RunPage, RunSteps } from './RunStage';
import { hairline, runInfo } from './strip';
import { useTestRun } from './useTestRun';
import { useElapsed } from './useElapsed';
import './run.css';

const DEFAULT_VP = { width: 1440, height: 900 };

export default function RunScreen() {
  const { appId = '', testId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { data: test, loading } = useLive<Test | null>((b, l) => b.test(appId, testId, l), [appId, testId]);
  const { data: apps } = useLive<App[]>((b, l) => b.apps(l), []);
  const app = apps?.find(a => a.id === appId);
  const r = useTestRun();
  const { view } = r;
  const info = useMemo(() => (r.steps ? runInfo(r.steps) : null), [r.steps]);

  const go = (t: Test) => { r.start(t).catch(() => { /* shown in the strip */ }); };
  const started = useRef(false);
  useEffect(() => {
    if (!test || started.current) return;
    started.current = true;
    go(test);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [test]);

  useEffect(() => { if (r.saveError) toast(`Couldn't save the run: ${r.saveError}`, { error: true }); }, [r.saveError, toast]);

  const running = view.phase === 'running' || view.phase === 'starting' || view.phase === 'idle';
  const ended = view.phase === 'ended' || view.phase === 'error';
  const elapsed = useElapsed(view.startedAt, view.phase === 'running');
  const shown = view.phase === 'ended' ? view.durationMs ?? elapsed : elapsed;
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate(`/apps/${appId}`));

  if (!loading && !test) {
    return (
      <AppFrame back={`/apps/${appId}`} crumb={app?.name} title="Test not found">
        <EmptyState icon="search_off" title="This test isn't here any more." text="Someone may have deleted it. Go back to see the tests in this app."
          action={<Button kind="primary" onClick={() => navigate(`/apps/${appId}`)}>Back to {app?.name ?? 'the app'}</Button>} />
      </AppFrame>
    );
  }

  const stopped = view.reasons[view.failedId ?? ''] === 'stopped';
  // A failed run offers the fix right in the strip (Run design "Failed"): re-record a top-level
  // step in place, or open the test on the failed row. Steps inside shared steps are fixed there.
  // Open in editor is then the one primary button; See report steps back to secondary (DES-08).
  const failedRow = view.failedId && info ? info.refs.get(view.failedId)?.rowId : undefined;
  const failedReason = view.reasons[view.failedId ?? ''];
  const record = `/apps/${appId}/tests/${testId}/record`;
  const offersFix = view.phase === 'ended' && view.result !== 'pass' && !stopped && !!failedRow;
  const word = view.phase === 'ended' ? (view.result === 'pass' ? 'passed' : stopped ? 'stopped' : 'failed') : view.phase === 'error' ? 'not started' : 'running';
  const actions = (
    <>
      <div className="run-timer" aria-label={`Time ${formatDuration(shown)}`}><Icon name="timer" />{formatDuration(shown)}</div>
      {running && <Button kind="primary" icon="stop" onClick={r.stop} disabled={view.phase !== 'running'}>Stop</Button>}
      {ended && test && <Button icon="replay" onClick={() => go(test)}>Run again</Button>}
      {view.phase === 'ended' && (
        <Button kind={offersFix ? 'secondary' : 'primary'} disabled={!r.run} onClick={() => r.run && navigate(`/apps/${appId}/runs/${r.run.id}`)}>See report</Button>
      )}
    </>
  );

  const stripExtra = offersFix && failedRow ? (
    <div className="run-strip-actions">
      {failedRow === view.failedId && failedReason !== 'secretMissing' && (
        <Button icon="replay" onClick={() => navigate(`${record}?rerecord=${encodeURIComponent(failedRow)}`)}>Re-record this step</Button>
      )}
      <Button kind="primary" icon="edit" onClick={() => navigate(`${record}?step=${encodeURIComponent(failedRow)}`)}>Open in editor</Button>
    </div>
  ) : undefined;

  return (
    <AppFrame back={back} crumb={app?.name ?? ' '} title={test ? `${test.name} · ${word}` : ' '} actions={actions}
      progress={info ? hairline(view, info) : { value: 0, tone: 'running' }}>
      <div className="run-body">
        <RunPage view={view} info={info} startUrl={test?.startUrl} viewport={test?.viewport ?? DEFAULT_VP} stripExtra={stripExtra} />
        <RunSteps view={view} info={info} steps={r.steps} />
      </div>
    </AppFrame>
  );
}

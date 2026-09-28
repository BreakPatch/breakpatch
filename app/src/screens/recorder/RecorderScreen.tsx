// Recorder (README "3 · Recorder"): /apps/:appId/tests/:testId/record, ?step=<id> opens on a
// step, ?rerecord=<id> starts re-recording it (from the report). Loads the test and its
// current version, opens the controlled browser at the start address, and saves new versions.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { App, RecordedOn, Test } from '../../data/types';
import { useBackend, useLive } from '../../data/hooks';
import { findStep, flatRows, numberOf, stripUi } from '../../components/steps';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, SharedChip, useToast } from '../../components/ui';
import { RecorderWorkbench } from './RecorderWorkbench';
import { SaveButton } from './SaveButton';
import { useLeaveGuard } from './useLeaveGuard';
import { useRecorder } from './useRecorder';
import { addressOf, useBrowserSession } from './browserSession';
import { hasFeature } from '../../edition';
import { filesDir } from '../../lib/testFiles';
import { editorStatuses, useEditorRun, type EditorRunDone } from './editorRun';
import { getEngine } from '../../engine';
import { recordedOnForSave } from './recordedOn';

const DEFAULT_VP = { width: 1440, height: 900 };

export default function RecorderScreen() {
  const { appId = '', testId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const toast = useToast();
  const { data: test, loading } = useLive<Test | null>((b, l) => b.test(appId, testId, l), [appId, testId]);
  const { data: apps } = useLive<App[]>((b, l) => b.apps(l), []);
  const app = apps?.find(a => a.id === appId);
  const viewport = test?.viewport ?? DEFAULT_VP;
  const rec = useRecorder({ viewport, onError: m => toast(m, { error: true }), appUrl: app?.baseUrl ?? test?.startUrl, filesDir: filesDir(backend.local?.path) });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const browser = useBrowserSession(test?.startUrl, test ? viewport : undefined, m => toast(m, { error: true }));
  const editorRun = useEditorRun({ test, steps: () => rec.stepsRef.current });
  const [done, setDone] = useState<EditorRunDone | null>(null);
  const [offerPlay, setOfferPlay] = useState<string | null>(null);

  // Load the current version once per test; later updates (our own saves) don't overwrite edits.
  const loadedFor = useRef<string | null>(null);
  const recordedOn = useRef<RecordedOn | undefined>(undefined);
  useEffect(() => {
    if (!test || loadedFor.current === test.id) return;
    loadedFor.current = test.id;
    void backend.version(appId, test.id, test.currentVersion).then(v => { recordedOn.current = v?.recordedOn; rec.load(v?.steps ?? []); setLoaded(true); });
  }, [test, backend, appId, rec]);

  // ?step= and ?rerecord= apply once the steps and the browser are ready.
  const applied = useRef(false);
  useEffect(() => {
    if (!loaded || !browser.ready || applied.current) return;
    applied.current = true;
    const step = params.get('step'), rr = params.get('rerecord');
    if (!step && !rr) return;
    const steps = rec.stepsRef.current;
    if (rr && findStep(steps, rr)) rec.startRerecord(rr);
    else if (step && findStep(steps, step)) rec.setSelectedId(step);
    setParams({}, { replace: true });
  }, [loaded, browser.ready, params, setParams, rec]);

  async function save(note?: string): Promise<boolean> {
    if (!test) return false;
    setSaving(true);
    try {
      const clean = stripUi(rec.stepsRef.current);
      const where = await recordedOnForSave(getEngine(), rec.recordedRef.current, recordedOn.current);
      const v = await backend.saveTest(appId, test.id, clean, note || undefined, where);
      recordedOn.current = v.recordedOn ?? where;
      rec.load(clean);
      toast(hasFeature('versions') ? `Saved as version ${v.number}` : 'Saved');
      return true;
    } catch (e) {
      toast(e instanceof Error ? `Couldn't save: ${e.message}` : "Couldn't save. Try again.", { error: true });
      return false;
    } finally { setSaving(false); }
  }

  const { guard, dialog } = useLeaveGuard(rec.dirty, () => save());

  /** Run (every step) or Play to here, in this browser. Never saves; the page stays where it ends. */
  async function play(mode: 'run' | 'play', upTo?: string) {
    if (rec.busy || editorRun.running) return;
    rec.cancelAi(); rec.cancelRerecord(); setDone(null); setOfferPlay(null);
    try {
      const d = await editorRun.start(mode, { upTo, keepRun: mode === 'run' && !rec.dirty });
      if (!d) return;
      setDone(d);
      const rows = flatRows(rec.stepsRef.current).map(r => r.step.id);
      const last = rows[rows.length - 1] ?? null;
      if (d.result === 'fail') {
        // Stopped at the failed step: new steps would go after the last one that passed.
        rec.played({ full: false, at: null, insertAfter: null });
        if (d.stoppedAt && findStep(rec.stepsRef.current, d.stoppedAt)) rec.setSelectedId(d.stoppedAt);
      } else if (mode === 'run') rec.played({ full: true, at: last, insertAfter: null });
      else rec.played({ full: false, at: upTo ?? null, insertAfter: upTo && upTo !== last ? upTo : null });
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't start the run.", { error: true });
    }
  }
  const addAfter = (id: string) => {
    if (rec.atStepId === id) { rec.setInsertAfter(id); setOfferPlay(null); return; }
    setOfferPlay(id);
  };
  const { statuses, notes } = editorStatuses(editorRun.view, rec.steps, editorRun.mode);
  const n = (id: string) => numberOf(rec.steps, id);
  let footer = null;
  if (offerPlay && findStep(rec.steps, offerPlay)) footer = (
    <div className="rec-runfoot" role="status">
      <span className="grow">The page isn't at step {n(offerPlay)} yet. Play the steps up to it first?</span>
      <Button size="sm" kind="primary" onClick={() => void play('play', offerPlay)}>Play to here</Button>
      <button type="button" className="rec-hint-link" onClick={() => { rec.setInsertAfter(offerPlay); setOfferPlay(null); }}>Just add it</button>
    </div>
  );
  else if (editorRun.running) footer = <div className="rec-runfoot" role="status"><span className="grow">{editorRun.mode === 'play' ? 'Playing the steps in this browser…' : 'Running the test in this browser…'}</span></div>;
  else if (done) footer = (
    <div className={'rec-runfoot ' + (done.result === 'pass' ? 'ok' : 'bad')} role="status">
      <span className="grow">{done.result === 'fail' ? (done.stoppedAt && findStep(rec.steps, done.stoppedAt) ? `Stopped at step ${n(done.stoppedAt)}. Fix it here, then run again.` : 'The run stopped.')
        : done.mode === 'play' ? `Played to step ${done.stoppedAt ? n(done.stoppedAt) : ''}. New steps go after it.` : 'Passed. New steps go at the end.'}</span>
      {done.runId && <Link className="rec-hint-link" to={`/apps/${appId}/runs/${done.runId}`}>See report</Link>}
    </div>
  );
  const runProps = { running: editorRun.running, statuses, notes, footer, onPlayTo: (id: string) => void play('play', id), onAddAfter: addAfter };
  const publish = async () => {
    if (!test) return;
    try { await backend.setTestStatus(appId, test.id, 'published'); toast('Added to the team suite'); }
    catch { toast("Couldn't add it to the team suite. Try again.", { error: true }); }
  };

  if (!loading && !test) {
    return (
      <AppFrame back={`/apps/${appId}`} crumb={app?.name} title="Test not found">
        <EmptyState icon="search_off" title="This test isn't here any more." text="Someone may have deleted it. Go back to see the tests in this app."
          action={<Button kind="primary" onClick={() => navigate(`/apps/${appId}`)}>Back to {app?.name ?? 'the app'}</Button>} />
      </AppFrame>
    );
  }

  const published = test?.status === 'published';
  const actions = test && (
    <>
      {hasFeature('collaboration') && <SharedChip published={published} />}
      {rec.dirty && <div className="rec-dirty" role="status">Unsaved changes</div>}
      {rec.dirty && !editorRun.running && <span className="rec-run-note" title="Running never saves the test">Runs your unsaved changes too</span>}
      {editorRun.running
        ? <Button icon="stop" onClick={editorRun.stop}>Stop</Button>
        : <Button icon="play_arrow" onClick={() => void play('run')} disabled={saving || rec.busy || rec.steps.length === 0}>Run</Button>}
      {hasFeature('collaboration') && !published && <Button icon="group_add" onClick={() => void publish()}>Add to team suite</Button>}
      <SaveButton nextVersion={test.currentVersion + 1} busy={saving} disabled={!rec.dirty || rec.busy || editorRun.running} onSave={note => save(note).then(() => undefined)} />
    </>
  );

  return (
    <AppFrame back={() => guard(() => navigate(`/apps/${appId}`))} crumb={app?.name ?? ' '} title={test?.name ?? ' '} actions={actions}>
      <RecorderWorkbench rec={rec} appId={appId} address={addressOf(test?.startUrl)} viewport={viewport} allowGroups
        loading={!loaded || !browser.ready} onEditGroup={id => guard(() => navigate(`/apps/${appId}/shared/${id}/edit`))} run={runProps} />
      {dialog}
    </AppFrame>
  );
}

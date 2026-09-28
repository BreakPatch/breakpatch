// Recorder (README "3 · Recorder"): /apps/:appId/tests/:testId/record, ?step=<id> opens on a
// step, ?rerecord=<id> starts re-recording it (from the report). Loads the test and its
// current version, opens the controlled browser at the start address, and saves new versions.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { App, Test } from '../../data/types';
import { useBackend, useLive } from '../../data/hooks';
import { findStep, stripUi } from '../../components/steps';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, SharedChip, useToast } from '../../components/ui';
import { RecorderWorkbench } from './RecorderWorkbench';
import { SaveButton } from './SaveButton';
import { useLeaveGuard } from './useLeaveGuard';
import { useRecorder } from './useRecorder';
import { addressOf, useBrowserSession } from './browserSession';
import { hasFeature } from '../../edition';

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
  const rec = useRecorder({ viewport, onError: m => toast(m, { error: true }), appUrl: app?.baseUrl ?? test?.startUrl });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const browser = useBrowserSession(test?.startUrl, test ? viewport : undefined, m => toast(m, { error: true }));

  // Load the current version once per test; later updates (our own saves) don't overwrite edits.
  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!test || loadedFor.current === test.id) return;
    loadedFor.current = test.id;
    void backend.version(appId, test.id, test.currentVersion).then(v => { rec.load(v?.steps ?? []); setLoaded(true); });
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
      const v = await backend.saveTest(appId, test.id, clean, note || undefined);
      rec.load(clean);
      toast(hasFeature('versions') ? `Saved as version ${v.number}` : 'Saved');
      return true;
    } catch (e) {
      toast(e instanceof Error ? `Couldn't save: ${e.message}` : "Couldn't save. Try again.", { error: true });
      return false;
    } finally { setSaving(false); }
  }

  const { guard, dialog } = useLeaveGuard(rec.dirty, () => save());
  const run = async () => { if (rec.dirty && !(await save())) return; navigate(`/apps/${appId}/tests/${testId}/run`); };
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
      <Button icon="play_arrow" onClick={() => void run()} disabled={saving || rec.busy || rec.steps.length === 0}>Run</Button>
      {hasFeature('collaboration') && !published && <Button icon="group_add" onClick={() => void publish()}>Add to team suite</Button>}
      <SaveButton nextVersion={test.currentVersion + 1} busy={saving} disabled={!rec.dirty || rec.busy} onSave={note => save(note).then(() => undefined)} />
    </>
  );

  return (
    <AppFrame back={() => guard(() => navigate(`/apps/${appId}`))} crumb={app?.name ?? ' '} title={test?.name ?? ' '} actions={actions}>
      <RecorderWorkbench rec={rec} appId={appId} address={addressOf(test?.startUrl)} viewport={viewport} allowGroups
        loading={!loaded || !browser.ready} onEditGroup={id => guard(() => navigate(`/apps/${appId}/shared/${id}/edit`))} />
      {dialog}
    </AppFrame>
  );
}

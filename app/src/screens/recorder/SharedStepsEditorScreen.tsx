// Shared steps editor (README "Shared steps editor", ui-requirements §5.8): the recorder for a
// step group, with the amber banner "Saving updates N tests that use the latest version."
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { App, StepGroup, Test } from '../../data/types';
import { useBackend, useLive } from '../../data/hooks';
import { stripUi } from '../../components/steps';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, Dialog, EmptyState, Icon, useToast } from '../../components/ui';
import { RecorderWorkbench } from './RecorderWorkbench';
import { SaveButton } from './SaveButton';
import { useLeaveGuard } from './useLeaveGuard';
import { useRecorder } from './useRecorder';
import { addressOf, useBrowserSession } from './browserSession';
import { useFeature } from '../../edition';

const VP = { width: 1440, height: 900 };

export default function SharedStepsEditorScreen() {
  const HISTORY = useFeature('versions');
  const { appId = '', groupId = '' } = useParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const toast = useToast();
  const { data: groups } = useLive<StepGroup[]>((b, l) => b.stepGroups(appId, l), [appId]);
  const { data: apps } = useLive<App[]>((b, l) => b.apps(l), []);
  const { data: tests } = useLive<Test[]>((b, l) => b.tests(appId, l), [appId]);
  const app = apps?.find(a => a.id === appId);
  const group = groups?.find(g => g.id === groupId);
  const viewport = app?.defaultViewport ?? VP;
  const rec = useRecorder({ viewport, onError: m => toast(m, { error: true }), appUrl: app?.baseUrl });
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showTests, setShowTests] = useState(false);
  const browser = useBrowserSession(app?.baseUrl, app ? viewport : undefined, m => toast(m, { error: true }));

  const loadedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!group || loadedFor.current === group.id) return;
    loadedFor.current = group.id;
    void backend.groupVersion(appId, group.id, group.currentVersion).then(v => { rec.load(v?.steps ?? []); setLoaded(true); });
  }, [group, backend, appId, rec]);

  async function save(note?: string): Promise<boolean> {
    if (!group) return false;
    setSaving(true);
    try {
      const clean = stripUi(rec.stepsRef.current);
      const v = await backend.saveGroup(appId, group.id, clean, note || undefined);
      rec.load(clean);
      toast(HISTORY ? `Saved as version ${v.number}` : 'Saved');
      return true;
    } catch (e) {
      toast(e instanceof Error ? `Couldn't save: ${e.message}` : "Couldn't save. Try again.", { error: true });
      return false;
    } finally { setSaving(false); }
  }
  const { guard, dialog } = useLeaveGuard(rec.dirty, () => save());
  const back = `/apps/${appId}?tab=shared`;

  if (groups && !group) {
    return (
      <AppFrame back={back} crumb={app?.name} title="Shared steps not found">
        <EmptyState icon="search_off" title="These shared steps aren't here any more." text="Someone may have deleted them. Go back to see the shared steps in this app."
          action={<Button kind="primary" onClick={() => navigate(back)}>Back to shared steps</Button>} />
      </AppFrame>
    );
  }

  const latest = group?.usedBy.filter(u => u.version === 'latest') ?? [];
  const pinned = group?.usedBy.filter(u => u.version !== 'latest') ?? [];
  const nameOf = (id: string) => tests?.find(t => t.id === id)?.name ?? id;
  const n = latest.length;

  const banner = group && (
    <div className="banner banner-fixed rec-group-banner" role="status">
      <Icon name="account_tree" size={20} />
      <div className="grow" style={{ fontSize: 14 }}>
        You're editing shared steps. Saving updates <b>{n} {n === 1 ? 'test' : 'tests'}</b> that use the latest version.
      </div>
      {group.usedBy.length > 0 && <button type="button" className="rec-hint-link" style={{ fontSize: 14 }} onClick={() => setShowTests(true)}>See tests</button>}
    </div>
  );

  const actions = group && (
    <>
      {rec.dirty && <div className="rec-dirty" role="status">Unsaved changes</div>}
      {HISTORY && <Button icon="history" onClick={() => guard(() => navigate(`/apps/${appId}/shared/${groupId}/history`))}>Versions</Button>}
      <SaveButton label={HISTORY ? `Save as version ${group.currentVersion + 1}` : 'Save'} nextVersion={group.currentVersion + 1} busy={saving}
        disabled={!rec.dirty || rec.busy} onSave={note => save(note).then(() => undefined)} />
    </>
  );

  return (
    <AppFrame back={() => guard(() => navigate(back))} crumb={group ? `${app?.name ?? ''} · Shared steps${HISTORY ? ` · Version ${group.currentVersion}` : ''}` : ' '}
      title={group?.name ?? ' '} actions={actions} banners={banner}>
      <RecorderWorkbench rec={rec} appId={appId} address={addressOf(app?.baseUrl)} viewport={viewport} allowGroups={false}
        loading={!loaded || !browser.ready} />
      {dialog}
      <Dialog open={showTests} onClose={() => setShowTests(false)} icon="account_tree" title={`Tests that use ${group?.name ?? 'these steps'}`}
        sub={`Saving changes ${n} ${n === 1 ? 'test' : 'tests'}. Tests kept on a fixed version don't change.`}
        actions={<Button kind="primary" onClick={() => setShowTests(false)}>Done</Button>}>
        <div className="col" style={{ gap: 4 }}>
          {[...latest, ...pinned].map(u => (
            <div key={u.testId} className="row" style={{ padding: '8px 0', borderBottom: '1px solid var(--line-soft)', fontSize: 14 }}>
              <span className="grow ellipsis">{nameOf(u.testId)}</span>
              {u.version === 'latest'
                ? <span className="row" style={{ gap: 4, color: 'var(--accent)', fontSize: 13 }}><Icon name="sync" size={16} />Always latest</span>
                : <span className="row" style={{ gap: 4, color: 'var(--text-faint)', fontSize: 13 }}><Icon name="push_pin" size={16} />Kept on version {u.version}</span>}
            </div>
          ))}
        </div>
      </Dialog>
    </AppFrame>
  );
}

// Suite editor (/suites/new, /suites/:suiteId): tests from any app in run order (design 7 ·
// Suite editor). The edition adds the side panel (Team: schedule, where the result goes, the
// suite ID for run requests) and the title-bar action (Run on runner) through edition.slots.
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, Checkbox, Dialog, Icon, IconButton, Skeleton, TextInput, useToast } from '../../components/ui';
import { useBackend, useLive } from '../../data/hooks';
import { KEEP_DELETED_DAYS, type DeletedItem } from '../../data/backend';
import type { App, Suite } from '../../data/types';
import { plural } from '../../components/common/format';
import { useAllTests } from './useAllTests';
import { swapTests } from './suiteOrder';
import { edition, type SuiteExtras } from '../../edition';
import './suites.css';

type Ref = Suite['tests'][number];
const key = (r: Ref) => `${r.appId}/${r.testId}`;
const { suiteEditorPanel: Panel, suiteEditorAction: Action } = edition.slots;

export default function SuiteEditorScreen() {
  const { suiteId } = useParams();
  const isNew = !suiteId;
  const navigate = useNavigate();
  const backend = useBackend();
  const toast = useToast();
  const suites = useLive<Suite[]>((b, l) => b.suites(l), []).data;
  const apps = useLive<App[]>((b, l) => b.apps(l), []).data;
  const testsByApp = useAllTests(apps);
  // Tests in Recently deleted (or in a deleted app) stay in the suite, skipped, until they're restored.
  const deleted = useLive<DeletedItem[]>((b, l) => b.recentlyDeleted?.items(l) ?? (l([]), () => {}), []).data;
  const suite = suiteId ? suites?.find(s => s.id === suiteId) : undefined;

  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Ref[]>([]);
  // Kept as loaded when no panel edits them, so saving never drops a schedule or address.
  const [extras, setExtras] = useState<SuiteExtras>({ schedule: null });
  const [extrasProblem, setExtrasProblem] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const loaded = useRef<string | null>(null);

  // Fill the form once per suite; later live updates don't overwrite what's being edited.
  useEffect(() => {
    if (isNew) { if (loaded.current !== 'new') { loaded.current = 'new'; } return; }
    if (!suite || loaded.current === suite.id) return;
    loaded.current = suite.id;
    setName(suite.name); setPicked(suite.tests);
    setExtras({ schedule: suite.schedule, ...(suite.resultUrl ? { resultUrl: suite.resultUrl } : {}), ...(suite.notify ? { notify: suite.notify } : {}) });
    setDirty(false);
  }, [isNew, suite]);

  const findTest = (r: Ref) => testsByApp?.[r.appId]?.find(t => t.id === r.testId);
  const inBin = (r: Ref) => !deleted || deleted.some(i => (i.kind === 'test' && i.appId === r.appId && i.id === r.testId) || (i.kind === 'app' && i.id === r.appId));
  const present = testsByApp ? picked.filter(r => findTest(r)) : picked;
  const binned = testsByApp && deleted ? picked.filter(r => !findTest(r) && inBin(r)) : [];
  const missing = testsByApp && deleted ? picked.length - present.length - binned.length : 0;
  /** What saving keeps: the tests there are, and the ones in Recently deleted, in their order. */
  const kept = testsByApp ? picked.filter(r => findTest(r) || inBin(r)) : picked;
  const pickedApps = new Set(present.map(r => r.appId)).size;
  const order = new Map(present.map((r, i) => [key(r), i + 1]));

  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setDirty(true); };
  const toggle = (r: Ref) => {
    setDirty(true);
    setPicked(p => p.some(x => key(x) === key(r)) ? p.filter(x => key(x) !== key(r)) : [...p, r]);
  };
  const move = (i: number, d: -1 | 1) => {
    setDirty(true);
    const [a, b] = [present[i], present[i + d]];
    if (a && b) setPicked(p => swapTests(p, a, b));
  };

  const problems = {
    name: !name.trim() ? 'Give the suite a name.' : undefined,
    tests: !present.length ? 'Pick at least one test.' : undefined,
    extras: extrasProblem,
  };
  const valid = !Object.values(problems).some(Boolean);

  const save = async (): Promise<Suite | null> => {
    setTried(true);
    if (!valid) return null;
    setSaving(true);
    try {
      const url = extras.resultUrl?.trim();
      const out = await backend.saveSuite(suiteId ?? null, { name: name.trim(), tests: kept, schedule: extras.schedule, ...(url ? { resultUrl: url } : {}), ...(extras.notify !== undefined ? { notify: extras.notify } : {}) });
      setDirty(false);
      toast(isNew ? `${out.name} created.` : 'Suite saved.');
      if (isNew) { loaded.current = out.id; navigate(`/suites/${out.id}`, { replace: true }); }
      return out;
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save the suite.", { error: true });
      return null;
    } finally { setSaving(false); }
  };

  /** Saves unsaved edits first, for the edition's title-bar action. */
  const prepare = async () => (dirty || !suite ? await save() : suite);

  const remove = async () => {
    if (!suiteId) return;
    try { await backend.deleteSuite(suiteId); toast(`${name || 'Suite'} moved to Recently deleted.`); navigate('/suites', { replace: true }); }
    catch (e) { toast(e instanceof Error ? e.message : "Couldn't delete the suite.", { error: true }); }
  };

  const notFound = !isNew && suites && !suite && loaded.current !== suiteId;
  if (notFound) {
    return (
      <AppFrame back="/suites" crumb="Suites" title="Suite">
        <div className="empty"><div className="empty-title">This suite no longer exists.</div><div className="empty-text">Someone may have deleted it.</div>
          <Button kind="primary" onClick={() => navigate('/suites')}>Back to suites</Button></div>
      </AppFrame>
    );
  }

  return (
    <AppFrame back="/suites" crumb="Suites" title={name.trim() || (isNew ? 'New suite' : suite?.name ?? 'Suite')}
      actions={<>
        <Button icon="play_arrow" disabled={saving} title="Run on this Mac, one test after another"
          onClick={async () => { const s = await prepare(); if (s) navigate(`/suites/${s.id}/run`); }}>Run</Button>
        {!isNew && Action && <Action suite={suite} prepare={prepare} disabled={saving} />}
        <Button kind="primary" onClick={() => void save()} busy={saving}>Save</Button>
      </>}>
      {/* Community has nothing for a side column: its one line and Delete suite head the main column (DES-16). */}
      <div className={'se-body' + (Panel ? '' : ' solo')}>
        <div className="se-left">
          {!Panel && (
            <div className="se-lead">
              <span className="se-next">Pick the tests and the order they run in.</span>
              {!isNew && <Button kind="dangerText" icon="delete" size="sm" onClick={() => setConfirmDelete(true)}>Delete suite</Button>}
            </div>
          )}
          <TextInput label="Name" className="se-name" value={name} placeholder="e.g. Smoke" onChange={e => edit(setName)(e.target.value)}
            error={tried ? problems.name : undefined} autoFocus={isNew} />
          <div className="se-hrow">
            <div className="se-h">Tests</div>
            <div className="se-count">{present.length ? `${present.length} picked from ${plural(pickedApps, 'app')} · run in this order` : 'None picked yet'}</div>
          </div>
          {tried && problems.tests && <div className="se-err" role="alert"><Icon name="error" />{problems.tests}</div>}
          {binned.length > 0 && (
            <div className="se-missing"><Icon name="delete" />
              <span>{binned.length === 1 ? '1 test in this suite is in Recently deleted.' : `${binned.length} tests in this suite are in Recently deleted.`} Runs skip {binned.length === 1 ? 'it' : 'them'} until {binned.length === 1 ? "it's" : "they're"} restored.</span>
            </div>
          )}
          {missing > 0 && (
            <div className="se-missing"><Icon name="warning" />
              <span>{missing === 1 ? '1 test in this suite no longer exists. Saving removes it.' : `${missing} tests in this suite no longer exist. Saving removes them.`}</span>
            </div>
          )}
          {!apps || !testsByApp ? [0, 1].map(i => (
            <div key={i} className="se-group"><div className="se-group-head"><Skeleton w={120} h={14} /></div>
              {[0, 1, 2].map(k => <div key={k} className="se-test"><Skeleton w={18} h={18} r={5} /><Skeleton w={200} h={13} /></div>)}</div>
          )) : apps.map(a => {
            const list = testsByApp[a.id] ?? [];
            const on = list.filter(t => order.has(`${a.id}/${t.id}`)).length;
            return (
              <div key={a.id} className="se-group">
                <div className="se-group-head"><Icon name={a.icon ?? 'language'} /><div className="se-group-name">{a.name}</div><div className="se-group-count">{on} of {list.length}</div></div>
                {!list.length && <div className="se-group-empty">No tests in this app yet.</div>}
                {list.map(t => {
                  const r = { appId: a.id, testId: t.id };
                  const n = order.get(key(r));
                  return (
                    <div key={t.id} className={`se-test${n ? ' on' : ''}`} onClick={() => toggle(r)}>
                      <span onClick={e => e.stopPropagation()} style={{ display: 'flex' }}><Checkbox checked={!!n} onChange={() => toggle(r)} label={t.name} hideLabel /></span>
                      <div className="se-test-name ellipsis">{t.name}</div>
                      {n && <span className="se-order-no" aria-label={`Runs number ${n}`}>{n}</span>}
                      <div className="se-test-steps">{plural(t.stepCount, 'step')}</div>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {present.length > 1 && testsByApp && (
            <>
              <div className="se-hrow" style={{ marginTop: 6 }}><div className="se-h">Run order</div><div className="se-count">In the order you picked them</div></div>
              <div className="se-order" role="list" aria-label="Run order">
                {present.map((r, i) => {
                  const t = findTest(r)!;
                  return (
                    <div key={key(r)} className="se-order-row" role="listitem">
                      <span className="n">{i + 1}</span>
                      <span className="t ellipsis">{t.name}</span>
                      <span className="a">{apps?.find(a => a.id === r.appId)?.name}</span>
                      <IconButton icon="arrow_upward" label={`Move ${t.name} up`} disabled={i === 0} onClick={() => move(i, -1)} />
                      <IconButton icon="arrow_downward" label={`Move ${t.name} down`} disabled={i === present.length - 1} onClick={() => move(i, 1)} />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {Panel && (
          <div className="se-right">
            <Panel suite={suite} suiteId={suiteId ?? null} name={name.trim() || 'New suite'} testCount={present.length} tried={tried}
              value={extras} onChange={(v, problem) => { setExtras(v); setExtrasProblem(problem); setDirty(true); }} />
            {!isNew && <Button kind="dangerText" icon="delete" className="se-danger" onClick={() => setConfirmDelete(true)}>Delete suite</Button>}
          </div>
        )}
      </div>

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title={`Delete ${name || 'this suite'}?`}
        sub={`It goes to Recently deleted with its schedule. You can restore it there for ${KEEP_DELETED_DAYS} days. Its past runs stay in the history.`}
        actions={<><Button onClick={() => setConfirmDelete(false)} data-autofocus>Cancel</Button><Button kind="danger" icon="delete" onClick={remove}>Delete suite</Button></>} />
    </AppFrame>
  );
}

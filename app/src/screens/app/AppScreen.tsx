// App: Tests · Shared steps · Runs for one app (README "2 · Home and tests", ui-requirements §5.4–5.5, §5.8, §5.18).
import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, Icon, Skeleton, Tabs, useToast } from '../../components/ui';
import { hostOf } from '../../components/common';
import { useBackend, useLive } from '../../data/hooks';
import type { App, Run, StepGroup, Test } from '../../data/types';
import { NewTestDialog } from './NewTestDialog';
import { RunsTab } from './RunsTab';
import { SharedTab } from './SharedTab';
import { TestsTab } from './TestsTab';
import './app.css';

type Tab = 'tests' | 'shared' | 'runs';
const TABS: Tab[] = ['tests', 'shared', 'runs'];

export default function AppScreen() {
  const { appId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const backend = useBackend();
  const toast = useToast();
  const tab: Tab = TABS.includes(params.get('tab') as Tab) ? (params.get('tab') as Tab) : 'tests';

  const apps = useLive<App[]>((b, l) => b.apps(l), []);
  const tests = useLive<Test[]>((b, l) => b.tests(appId, l), [appId]);
  const groups = useLive<StepGroup[]>((b, l) => b.stepGroups(appId, l), [appId]);
  const runs = useLive<Run[]>((b, l) => b.runs(appId, l), [appId]);
  const app = apps.data?.find(a => a.id === appId);

  const [newOpen, setNewOpen] = useState(false);
  // ?new (from the first-use checklist) opens the New test dialog once.
  useEffect(() => {
    if (!params.has('new') || !app) return;
    setNewOpen(true);
    setParams(p => { p.delete('new'); return p; }, { replace: true });
  }, [params, app, setParams]);

  const setTab = (t: Tab) => setParams(p => { if (t === 'tests') p.delete('tab'); else p.set('tab', t); return p; }, { replace: true });

  if (apps.data && !app) {
    return (
      <AppFrame back="/" title="App">
        <EmptyState icon="search_off" title="This app isn't here any more." text="Someone may have deleted it. Pick another app on Home."
          action={<Button kind="primary" icon="arrow_back" onClick={() => navigate('/')}>Back to apps</Button>} />
      </AppFrame>
    );
  }

  const firstTest = tests.data?.[0];
  // "Run all" opens the first test's run view until suite-style multi-test runs exist in the app.
  const runAll = () => {
    if (!firstTest) { toast('Add a test first, then run it.'); return; }
    navigate(`/apps/${appId}/tests/${firstTest.id}/run`);
  };
  const newGroup = async () => {
    const g = await backend.createGroup(appId, 'New shared steps', '', []);
    navigate(`/apps/${appId}/shared/${g.id}/edit`);
  };

  const count = (n: number | undefined) => (n === undefined ? '' : ` · ${n}`);
  const loading = tab === 'tests' ? tests.loading : tab === 'shared' ? groups.loading || tests.loading : runs.loading;
  const slow = tab === 'tests' ? tests.slow : tab === 'shared' ? groups.slow : runs.slow;
  const name = app?.name ?? '';

  return (
    <AppFrame back="/" crumb={app ? hostOf(app.baseUrl) : <Skeleton w={110} h={10} />} title={app ? name : <Skeleton w={90} h={14} style={{ marginTop: 3 }} />}
      actions={tab === 'shared' ? (
        <Button kind="primary" icon="add" aria-keyshortcuts="Meta+N" onClick={newGroup} disabled={!app}>New shared steps</Button>
      ) : <>
        <Button icon="playlist_play" onClick={runAll} disabled={!tests.data?.length}>Run all</Button>
        <Button kind="primary" icon="add" aria-keyshortcuts="Meta+N" onClick={() => setNewOpen(true)} disabled={!app}>New test</Button>
      </>}>
      <Tabs<Tab> label={`${name} sections`} value={tab} onChange={setTab} items={[
        { value: 'tests', label: `Tests${count(tests.data?.length)}` },
        { value: 'shared', label: `Shared steps${count(groups.data?.length)}` },
        { value: 'runs', label: 'Runs' },
      ]} />
      <div className="app-body" key={tab}>
        {!app || loading ? <TableSkeleton slow={slow} />
          : tab === 'tests' ? (
            tests.data!.length ? <TestsTab app={app} tests={tests.data!} />
              : <EmptyState icon="radio_button_checked" title={`No tests for ${name} yet.`}
                  text="Use the app the way a user would. Every click becomes a step you can replay later."
                  action={<Button kind="primary" size="lg" icon="add" onClick={() => setNewOpen(true)}>Create your first test</Button>} />
          ) : tab === 'shared' ? (
            groups.data!.length ? <SharedTab app={app} groups={groups.data!} tests={tests.data!} />
              : <EmptyState icon="account_tree" title="No shared steps yet."
                  text="Record steps you repeat, like logging in, once. Then insert them into any test and edit them in one place."
                  action={<Button kind="primary" size="lg" icon="add" onClick={newGroup}>New shared steps</Button>} />
          ) : (
            runs.data!.length ? <RunsTab app={app} runs={runs.data!} />
              : <EmptyState icon="play_circle" title="Nothing has run yet." text="Runs from your Mac, the local runner and CI all show up here."
                  action={<div className="row" style={{ gap: 10, marginTop: 4 }}>
                    <Button kind="primary" size="lg" icon="playlist_play" onClick={runAll} disabled={!tests.data?.length}>Run all tests</Button>
                    <Button size="lg" onClick={() => setTab('tests')}>Open Tests</Button>
                  </div>} />
          )}
      </div>
      {app && <NewTestDialog open={newOpen} app={app} onClose={() => setNewOpen(false)} />}
    </AppFrame>
  );
}

function TableSkeleton({ slow }: { slow: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="app-toolbar"><Skeleton w={280} h={34} r={8} /><Skeleton w={110} h={30} r={100} /><Skeleton w={110} h={30} r={100} /></div>
      <div className="app-table">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="app-row app-skel-row" style={{ opacity: 1 - i * 0.09 }}>
            <div className="col" style={{ gap: 6, flex: 1 }}><Skeleton w={`${40 - (i % 3) * 6}%`} h={12} r={4} /><Skeleton w={60} h={10} r={4} /></div>
            <Skeleton w={110} h={22} r={100} /><Skeleton w={120} h={12} r={4} /><Skeleton w={100} h={12} r={4} />
          </div>
        ))}
      </div>
      {slow && <div className="app-slow" role="status"><Icon name="hourglass_top" size={17} />Still loading. Your connection may be slow.</div>}
    </div>
  );
}

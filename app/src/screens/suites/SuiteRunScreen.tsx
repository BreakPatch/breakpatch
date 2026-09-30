// Run a suite by hand on this Mac (/suites/:suiteId/run): its tests one after another through
// the same run machinery as the Run view. Live page and strip on the left (like runner mode),
// the suite's tests with their status on the right, a report link per finished test.
// The app screen's Run all (/apps/:appId/run-all) is the same run over every test of that app,
// as a suite made on the spot: each test's run is saved, but there's no suite to save a result on.
// Tests with no saved steps yet (drafts) are left out of it: they can't run, so they don't fail it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import type { App, Suite, Test } from '../../data/types';
import { useBackend, useLive } from '../../data/hooks';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, Icon, useToast } from '../../components/ui';
import { clock, formatDuration, plural } from '../../components/common/format';
import { useSession } from '../../state/session';
import { notifyFinished } from '../../lib/notify';
import { hasFeature } from '../../edition';
import { RunPage } from '../run/RunStage';
import { runInfo, runStrip, type Strip } from '../run/strip';
import { reasonTitle } from '../run/reasons';
import { useTestRun } from '../run/useTestRun';
import { useElapsed } from '../run/useElapsed';
import { preorder } from '../run/resolve';
import {
  doneCount, INITIAL_SUITE, nextIndex, planSuite, suiteCounts, suiteReducer, suiteResult, testOutcome,
  type SuiteAction, type SuiteItem, type SuiteRunView, type SuiteTestState,
} from '../run/suiteRun';
import { useAllTests } from './useAllTests';
import '../run/run.css';

const DEFAULT_VP = { width: 1440, height: 900 };

const ITEM: Record<SuiteTestState, { icon: string; tone: string; word: string }> = {
  waiting: { icon: 'schedule', tone: 'muted', word: 'Waiting' },
  running: { icon: 'progress_activity', tone: 'running', word: 'Running' },
  passed: { icon: 'check_circle', tone: 'passed', word: 'Passed' },
  fixed: { icon: 'auto_fix_high', tone: 'fixed', word: 'Fixed automatically' },
  failed: { icon: 'cancel', tone: 'failed', word: 'Failed' },
  notRun: { icon: 'block', tone: 'muted', word: 'Not run' },
  missing: { icon: 'error', tone: 'failed', word: "Couldn't run" },
};

/** What runs: a saved suite, or every test of one app (Run all). `drafts`: Run all's tests left out, with no steps yet. */
interface Plan { name: string; tests: Suite['tests']; suite?: Suite; app?: App; drafts?: Test[] }

export default function SuiteRunScreen() {
  const { suiteId, appId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const backend = useBackend();
  const toast = useToast();
  const suites = useLive<Suite[]>((b, l) => b.suites(l), []).data;
  const apps = useLive<App[]>((b, l) => b.apps(l), []).data;
  const app = appId ? apps?.find(a => a.id === appId) : undefined;
  // Run all needs only its app's tests.
  const testsByApp = useAllTests(appId ? apps?.filter(a => a.id === appId) : apps);
  const suite = suiteId ? suites?.find(s => s.id === suiteId) : undefined;
  const plan = useMemo<Plan | undefined>(() => {
    if (suiteId) return suite && { name: suite.name, tests: suite.tests, suite };
    // Only once the app's tests have loaded: until then there's nothing to say "no tests" about.
    if (!app || !testsByApp || !(app.id in testsByApp)) return undefined;
    const all = testsByApp[app.id];
    const recorded = all.filter(t => t.currentVersion > 0);
    return { name: 'All tests', tests: recorded.map(t => ({ appId: app.id, testId: t.id })), app, drafts: all.filter(t => t.currentVersion === 0) };
  }, [suiteId, suite, app, testsByApp]);
  const run = useTestRun();
  const { start } = run;
  const info = useMemo(() => (run.steps ? runInfo(run.steps) : null), [run.steps]);

  const [view, setView] = useState<SuiteRunView>(INITIAL_SUITE);
  const state = useRef(view);
  const act = useCallback((a: SuiteAction) => { state.current = suiteReducer(state.current, a); setView(state.current); }, []);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const findTest = useCallback((appId: string, testId: string): Test | undefined => testsByApp?.[appId]?.find(t => t.id === testId), [testsByApp]);

  const runAll = useCallback(async () => {
    if (!plan || !apps) return;
    act({ type: 'plan', items: planSuite(plan, findTest, apps) });
    act({ type: 'begin', at: Date.now() });
    const runIds: string[] = [];
    for (let i = nextIndex(state.current); i >= 0; i = nextIndex(state.current)) {
      const item = state.current.items[i];
      const test = findTest(item.appId, item.testId);
      act({ type: 'testStart', index: i });
      if (!test) { act({ type: 'testEnd', index: i, state: 'missing', note: "Couldn't run: it was deleted" }); continue; }
      try {
        const out = await start(test, { notify: false });
        if (!out || !alive.current) return;                       // left the screen
        if (out.run) runIds.push(out.run.id);
        const stopped = out.ended.steps.some(s => s.reason === 'stopped');
        const failed = out.ended.steps.filter(s => s.result === 'failed').pop();
        const flat = preorder(out.steps);
        const step = failed ? flat.find(s => s.id === failed.stepId) : undefined;
        const healed = out.run?.healedCount ?? out.ended.steps.filter(s => s.result === 'healed').length;
        act({
          type: 'testEnd', index: i, runId: out.run?.id,
          state: stopped ? 'notRun' : testOutcome(out.ended.result, healed),
          note: stopped ? 'You stopped it' : failed && step ? reasonTitle(failed.reason, step) : undefined,
        });
      } catch (e) {
        if (!alive.current) return;
        act({ type: 'testEnd', index: i, state: 'failed', note: `Couldn't run: ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    act({ type: 'end', at: Date.now() });
    const done = state.current;
    const counts = suiteCounts(done.items);
    const user = useSession.getState().user ?? backend.currentUser();
    const durationMs = (done.finishedAt ?? Date.now()) - (done.startedAt ?? Date.now());
    const failedCount = counts.failed + counts.notRun;
    const { suite } = plan;
    void notifyFinished(suite
      ? { kind: 'suite', name: suite.name, tests: counts.total, failed: failedCount, durationMs, path: `/suites/${suite.id}` }
      : { kind: 'app', name: plan.app?.name ?? '', tests: counts.total, failed: failedCount, durationMs, path: `/apps/${plan.app?.id}?tab=runs` },
      useSession.getState().prefs);
    if (!suite) return;                                            // Run all: each test's run is saved already
    try {
      await backend.addSuiteRun({
        suiteId: suite.id, suiteName: suite.name, result: suiteResult(counts), counts, testRunIds: runIds,
        requestedBy: user?.name ?? 'This Mac', startedAt: done.startedAt ?? Date.now(), finishedAt: done.finishedAt ?? Date.now(),
      });
    } catch (e) {
      toast(`Couldn't save the suite's result: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    }
  }, [plan, apps, findTest, act, start, backend, toast]);

  // Starts once everything is loaded.
  const started = useRef(false);
  useEffect(() => {
    if (started.current || !plan || !plan.tests.length || !apps || !testsByApp) return;
    started.current = true;
    void runAll();
  }, [plan, apps, testsByApp, runAll]);

  const stop = () => { act({ type: 'stop' }); run.stop(); };
  const running = view.phase !== 'ended';
  const elapsed = useElapsed(view.startedAt, view.phase === 'running');
  const shown = view.phase === 'ended' && view.startedAt && view.finishedAt ? view.finishedAt - view.startedAt : elapsed;
  const home = appId ? `/apps/${appId}` : '/suites';
  const back = () => (location.key !== 'default' ? navigate(-1) : navigate(home));
  const crumb = appId ? app?.name ?? ' ' : 'Suites';

  if (suiteId ? suites && !suite : apps && !app) {
    return (
      <AppFrame back={home} crumb={crumb} title={suiteId ? 'Suite' : 'All tests'}>
        {suiteId
          ? <EmptyState icon="search_off" title="This suite no longer exists." text="Someone may have deleted it."
              action={<Button kind="primary" onClick={() => navigate('/suites')}>Back to suites</Button>} />
          : <EmptyState icon="search_off" title="This app isn't here any more." text="Someone may have deleted it. Pick another app on Home."
              action={<Button kind="primary" icon="arrow_back" onClick={() => navigate('/')}>Back to apps</Button>} />}
      </AppFrame>
    );
  }
  if (plan?.app && !plan.tests.length && view.phase === 'idle') {
    return (
      <AppFrame back={home} crumb={crumb} title="All tests">
        <EmptyState icon="playlist_play" title={plan.drafts?.length ? `No recorded tests for ${plan.app.name} yet.` : `No tests for ${plan.app.name} yet.`}
          text={plan.drafts?.length ? "Record a test's steps first, then run them all." : 'Add a test first, then run them all.'}
          action={<Button kind="primary" icon="arrow_back" onClick={() => navigate(home)}>Back to {plan.app.name}</Button>} />
      </AppFrame>
    );
  }

  const counts = suiteCounts(view.items);
  const done = doneCount(view.items);
  const total = view.items.length || plan?.tests.length || 0;
  const cur = view.index >= 0 ? view.items[view.index] : undefined;
  const curTest = cur ? findTest(cur.appId, cur.testId) : undefined;
  const result = view.phase === 'ended' ? suiteResult(counts) : undefined;
  const word = view.phase === 'ended' ? (view.stopped ? 'stopped' : result === 'failed' ? 'failed' : 'finished') : 'running';

  const drafts = plan?.drafts ?? [];
  // Named again at the end, so a test left out isn't forgotten by then (DES2-16).
  const leftOut = drafts.length ? ` ${drafts.length === 1 ? `${drafts[0].name} has` : `${plural(drafts.length, 'test')} have`} no steps yet, so ${drafts.length === 1 ? 'it was' : 'they were'} left out.` : '';
  let strip: Strip | undefined;
  if (view.phase === 'ended') {
    const ok = result !== 'failed';
    strip = view.stopped
      ? { icon: 'block', tone: 'muted', title: 'You stopped the suite', text: `${done} of ${plural(total, 'test')} ran.` }
      : { icon: ok ? (counts.fixed ? 'auto_fix_high' : 'check_circle') : 'cancel', tone: ok ? (counts.fixed ? 'fixed' : 'passed') : 'failed',
          title: ok ? (counts.fixed ? 'Passed with fixes' : 'Passed') : `${plural(counts.failed, 'test')} failed`,
          text: (ok ? `All ${plural(total, 'test')} worked.` : `${counts.passed + counts.fixed} of ${plural(total, 'test')} passed. Open a failed test's report to see what happened.`) + leftOut };
  } else if (cur && info) {
    const s = runStrip(run.view, info);
    strip = { ...s, title: `${cur.name} · ${s.title}`, text: `${s.text} · ${cur.appName}` };
  } else if (cur) {
    strip = { icon: 'progress_activity', tone: 'running', motion: 'spin', title: cur.name, text: `Starting · ${cur.appName}` };
  }

  const actions = (
    <>
      <div className="run-timer" aria-label={`Time ${formatDuration(shown)}`}><Icon name="timer" />{formatDuration(shown)}</div>
      {running ? <Button kind="primary" icon="stop" onClick={stop} disabled={view.phase !== 'running' || view.stopped}>Stop</Button>
        : <Button kind="primary" icon="replay" onClick={() => void runAll()}>Run again</Button>}
    </>
  );

  return (
    <AppFrame back={back} crumb={crumb} title={plan ? `${plan.name} · ${word}` : ' '} actions={actions}
      progress={{ value: total ? done / total : 0, tone: view.phase === 'ended' ? (result === 'failed' ? 'failed' : 'passed') : 'running' }}>
      <div className="run-body">
        <RunPage view={view.phase === 'ended' ? { ...run.view, phase: 'ended' } : run.view} info={view.phase === 'ended' ? null : info}
          startUrl={curTest?.startUrl ?? run.test?.startUrl} viewport={curTest?.viewport ?? run.test?.viewport ?? DEFAULT_VP} strip={strip} />
        <aside className="srun-side" aria-label={plan?.app ? `All tests in ${plan.app.name}` : `${plan?.name ?? 'Suite'} tests`}>
          <div className="srun-head">
            <div className="srun-head-row"><div className="srun-name ellipsis">{plan?.app ? `All tests in ${plan.app.name}` : plan?.name ?? ' '}</div><div className="srun-count">{done} of {total}</div></div>
            <div className="srun-sub">{view.startedAt ? `Started ${clock(view.startedAt)} · on this Mac, one test after another` : 'Getting the tests ready'}</div>
          </div>
          <div className="srun-list" role="list">
            {/* One app (Run all): its name is in the heading, not on every row. */}
            {view.items.map((it, i) => <SuiteRow key={`${it.appId}/${it.testId}/${i}`} item={it} oneApp={!!plan?.app} onReport={it.runId ? () => navigate(`/apps/${it.appId}/runs/${it.runId}`) : undefined} />)}
            {drafts.map(t => (
              <div key={`draft/${t.id}`} className="srun-t draft" role="listitem" aria-label={`${t.name}, no steps yet, left out`}>
                <Icon name="edit" className="run-tone-muted" />
                <div className="srun-t-main"><div className="srun-t-name">{t.name}</div><div className="srun-t-note">No steps yet, so it's left out</div></div>
                <button type="button" className="srun-t-link" onClick={() => navigate(`/apps/${t.appId}/tests/${t.id}/record`)} aria-label={`Record ${t.name}`}>Record</button>
              </div>
            ))}
          </div>
          <div className="srun-foot" aria-label="Tally">
            <span><Icon name="check_circle" className="run-tone-passed" />{counts.passed} passed</span>
            {(hasFeature('autoFix') || counts.fixed > 0) && <span><Icon name="auto_fix_high" className="run-tone-fixed" />{counts.fixed} fixed</span>}
            <span><Icon name="cancel" className="run-tone-failed" />{counts.failed} failed</span>
            {view.phase === 'ended' && counts.notRun > 0 && <span><Icon name="block" className="run-tone-muted" />{counts.notRun} not run</span>}
          </div>
        </aside>
      </div>
    </AppFrame>
  );
}

function SuiteRow({ item, onReport, oneApp }: { item: SuiteItem; onReport?: () => void; oneApp?: boolean }) {
  const st = ITEM[item.state];
  return (
    <div className={`srun-t ${item.state}`} role="listitem" aria-current={item.state === 'running' || undefined} aria-label={`${item.name}, ${item.appName}, ${st.word}`}>
      <Icon name={st.icon} className={`run-tone-${st.tone}${item.state === 'running' ? ' spin' : ''}`} />
      <div className="srun-t-main">
        <div className="srun-t-name">{item.name}</div>
        {item.note && <div className="srun-t-note">{item.note}</div>}
      </div>
      {onReport ? <button type="button" className="srun-t-link" onClick={onReport} aria-label={`See the report for ${item.name}`}>See report</button>
        : !oneApp && <div className="srun-t-app">{item.appName}</div>}
    </div>
  );
}

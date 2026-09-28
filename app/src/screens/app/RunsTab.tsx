// Runs tab: every run across the app's tests, filterable by test, result, where and who.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, StatusPill } from '../../components/ui';
import { FilterChip, WHERE, formatDuration, formatWhen, plural, runBy, runStatus } from '../../components/common';
import type { App, Run, RunSource } from '../../data/types';
import { useFeature } from '../../edition';
import { distinct, filterRuns, type ResultFilter } from './filters';

// Community: one person and the latest version only, so no Who and no Version. The features
// follow the licence while the app runs (edition/features.ts), so they're read in the component.

const WEEK = 7 * 86_400_000;

export function RunsTab({ app, runs }: { app: App; runs: Run[] }) {
  const TEAM = useFeature('collaboration'), HISTORY = useFeature('versions'), COLS = TEAM || HISTORY ? 'app-cols-runs' : 'app-cols-runs-solo';
  const navigate = useNavigate();
  const [testId, setTestId] = useState('all');
  const [result, setResult] = useState<ResultFilter>('all');
  const [where, setWhere] = useState<'all' | RunSource>('all');
  const [who, setWho] = useState('all');

  const testOpts = useMemo(() => distinct(runs, r => r.testId).map(r => ({ value: r.testId, label: r.testName })), [runs]);
  const whoOpts = useMemo(() => distinct(runs.map(runBy), x => x).map(n => ({ value: n, label: n })), [runs]);
  const shown = filterRuns(runs, { testId, result, where, who });
  const filtered = testId !== 'all' || result !== 'all' || where !== 'all' || who !== 'all';
  const now = Date.now();
  const inWeek = shown.every(r => now - r.startedAt <= WEEK);
  const clear = () => { setTestId('all'); setResult('all'); setWhere('all'); setWho('all'); };

  return (
    <>
      <div className="app-toolbar">
        <FilterChip value={testId} onChange={setTestId} options={[{ value: 'all', label: 'All tests' }, ...testOpts]} />
        <FilterChip name="Result" allLabel="all" value={result} onChange={setResult}
          options={[{ value: 'all', label: 'Any result' }, { value: 'passed', label: 'Passed' }, { value: 'passedWithFixes', label: 'Passed with fixes' }, { value: 'failed', label: 'Failed' }]} />
        <FilterChip name="Where" allLabel="all" value={where} onChange={setWhere}
          options={[{ value: 'all', label: 'Anywhere' }, ...(Object.keys(WHERE) as RunSource[]).map(k => ({ value: k, label: WHERE[k].label }))]} />
        {TEAM && <FilterChip name="Who" allLabel="anyone" value={who} onChange={setWho} options={[{ value: 'all', label: 'Anyone' }, ...whoOpts]} />}
        <div className="grow" />
        <div className="app-toolbar-note">{inWeek ? `Last 7 days · ${plural(shown.length, 'run')}` : plural(shown.length, 'run')}</div>
      </div>
      <div className="app-table" role="table" aria-label="Runs">
        <div className={`app-row app-row-head ${COLS}`} role="row">
          <div role="columnheader">Result</div><div role="columnheader">Test</div><div role="columnheader">When</div>{COLS === 'app-cols-runs' && <div role="columnheader">Who</div>}
          <div role="columnheader">Where</div>{COLS === 'app-cols-runs' && <div role="columnheader">Version</div>}<div role="columnheader">Took</div><div role="columnheader"><span className="sr-only">Open</span></div>
        </div>
        {shown.map((r, i) => {
          const w = WHERE[r.source];
          const open = () => navigate(`/apps/${app.id}/runs/${r.id}`);
          return (
            <div key={r.id} className={`app-row ${COLS} clickable app-row-run`} role="row" tabIndex={0} aria-label={`${r.testName}, ${formatWhen(r.startedAt)}, open report`}
              style={{ animationDelay: `${Math.min(i, 12) * 25}ms` }} onClick={open} onKeyDown={e => { if (e.key === 'Enter') open(); }}>
              <div role="cell"><StatusPill status={runStatus(r)} /></div>
              <div role="cell" className="app-name ellipsis">{r.testName}</div>
              <div role="cell" className="app-text2">{formatWhen(r.startedAt)}</div>
              {COLS === 'app-cols-runs' && <div role="cell" className="app-text2 ellipsis">{runBy(r)}</div>}
              <div role="cell" className="app-where"><Icon name={w.icon} size={17} />{w.label}</div>
              {COLS === 'app-cols-runs' && <div role="cell" className="app-muted">v{r.testVersion}</div>}
              <div role="cell" className="app-muted">{formatDuration(r.durationMs)}</div>
              <Icon name="chevron_right" size={20} className="faint" />
            </div>
          );
        })}
        {!shown.length && filtered && <div className="app-nomatch">No runs match. <Button kind="link" size="sm" onClick={clear}>Clear filters</Button></div>}
      </div>
    </>
  );
}

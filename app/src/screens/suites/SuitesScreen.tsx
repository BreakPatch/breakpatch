// Suites (top nav): workspace-level list of suites (design 7 · Suites, ui-requirements §5.14).
// The edition adds columns (Team: Schedule, Result goes to), the row action (Run on runner)
// and the running-row tint through edition.slots. Run (on this Mac) is open: /suites/:suiteId/run.
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppFrame } from '../../components/shell/AppFrame';
import { Button, EmptyState, Icon, Skeleton, statusInfo } from '../../components/ui';
import { useLive } from '../../data/hooks';
import type { App, Suite } from '../../data/types';
import { formatWhen } from '../../components/common/format';
import { suiteResultStatus, testsLine } from '../../components/common/suites';
import { edition } from '../../edition';
import './suites.css';
import { ariaShortcut, osText, thisComputer } from '../../lib/osWords';

const { suiteColumns = [], suiteRowAction: RowAction, suitesNote } = edition.slots;
const BEFORE = suiteColumns.filter(c => !c.afterLastRun), AFTER = suiteColumns.filter(c => c.afterLastRun);
const useRunningSuite = edition.slots.useRunningSuite ?? (() => undefined);
const colsStyle = { '--su-cols': ['minmax(0, 1fr)', ...BEFORE.map(c => c.width), '190px', ...AFTER.map(c => c.width), RowAction ? '250px' : '90px'].join(' ') } as CSSProperties;

export default function SuitesScreen() {
  const navigate = useNavigate();
  const suites = useLive<Suite[]>((b, l) => b.suites(l), []);
  const apps = useLive<App[]>((b, l) => b.apps(l), []).data;
  const cur = useRunningSuite();
  const list = suites.data;

  return (
    <AppFrame nav="suites" actions={list?.length ? <Button kind="primary" icon="add" aria-keyshortcuts={ariaShortcut('N')} onClick={() => navigate('/suites/new')}>New suite</Button> : undefined}>
      {list && !list.length ? (
        <EmptyState icon="playlist_add_check" title="No suites yet."
          text="A suite is a set of tests you run together, from any app: a quick smoke check, a nightly run, a release check."
          action={<Button kind="primary" size="lg" icon="add" onClick={() => navigate('/suites/new')}>New suite</Button>} />
      ) : (
        <div className="su-page">
          <div className="su-head"><h2 className="page-title">Suites</h2>{suitesNote && <span className="faint su-head-note">{suitesNote}</span>}</div>
          <div role="table" aria-label="Suites" className="su-table" style={colsStyle}>
            <div role="row" className="su-row su-th">
              <div role="columnheader">Name</div>
              {BEFORE.map(c => <div key={c.header} role="columnheader">{c.header}</div>)}
              <div role="columnheader">Last run</div>
              {AFTER.map(c => <div key={c.header} role="columnheader">{c.header}</div>)}
              <div role="columnheader"><span className="sr-only">Actions</span></div>
            </div>
            {!list && [0, 1, 2].map(i => (
              <div role="row" key={i} className="su-row su-tr">
                <div className="col" style={{ gap: 6 }}><Skeleton w={120} h={15} /><Skeleton w={170} h={11} /></div>
                {BEFORE.map(c => <Skeleton key={c.header} w={120} h={13} />)}
                <div className="col" style={{ gap: 6 }}><Skeleton w={90} h={13} /><Skeleton w={130} h={11} /></div>
                {AFTER.map(c => <Skeleton key={c.header} w={110} h={13} />)}<div />
              </div>
            ))}
            {list?.map(s => {
              const running = cur?.suiteId === s.id;
              return (
                <div role="row" key={s.id} className={`su-row su-tr${running ? ' su-running' : ''}`} tabIndex={0}
                  onClick={() => navigate(`/suites/${s.id}`)} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) navigate(`/suites/${s.id}`); }}>
                  <div role="cell" className="col" style={{ gap: 3, minWidth: 0 }}>
                    <div className="su-name ellipsis">{s.name}</div>
                    <div className="su-sub ellipsis">{testsLine(s, apps)}</div>
                  </div>
                  {BEFORE.map(c => <div key={c.header} role="cell" className="su-meta"><c.Cell suite={s} /></div>)}
                  <div role="cell"><LastRun suite={s} running={running ? cur : undefined} /></div>
                  {AFTER.map(c => <div key={c.header} role="cell" className="su-meta"><c.Cell suite={s} /></div>)}
                  <div role="cell" className="su-act" onClick={e => e.stopPropagation()}>
                    <Button size="sm" icon="play_arrow" disabled={!s.tests.length} onClick={() => navigate(`/suites/${s.id}/run`)}
                      aria-label={`Run ${s.name} on ${thisComputer()}`} title={osText('Run on this Mac, one test after another')}>Run</Button>
                    {RowAction && <RowAction suite={s} />}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </AppFrame>
  );
}

function LastRun({ suite, running }: { suite: Suite; running?: { index: number; total: number } }) {
  if (running) {
    return (
      <div className="col" style={{ gap: 2 }}>
        <div className="su-result" style={{ color: 'var(--running)' }}><Icon name="progress_activity" size={17} className="spin" />Running now</div>
        <div className="su-sub">{running.index} of {running.total} done</div>
      </div>
    );
  }
  if (!suite.lastRun) return <div className="su-result" style={{ color: 'var(--text-faint)' }}><Icon name="radio_button_unchecked" size={17} />Never run</div>;
  const st = statusInfo(suiteResultStatus(suite.lastRun.result));
  const by = suite.lastRun.by === 'Schedule' ? 'schedule' : suite.lastRun.by;
  return (
    <div className="col" style={{ gap: 2 }}>
      <div className="su-result" style={{ color: st.color }}><Icon name={st.icon} size={17} />{st.word}</div>
      <div className="su-sub">{formatWhen(suite.lastRun.at)} · {by}</div>
    </div>
  );
}

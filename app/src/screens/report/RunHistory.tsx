// Run history, the report's second tab: every run of this test, newest first.
import type { Run } from '../../data/types';
import { Button, Icon, StatusPill } from '../../components/ui';
import { formatDateTime } from '../../components/common/format';
import { tookText } from './reportData';
import { runBy, runStatus, WHERE } from '../../components/common/runs';
import { hasFeature } from '../../edition';

/** `more`: shows older runs (the list holds the newest page). */
export function RunHistory({ runs, currentId, onOpen, more }: { runs: Run[]; currentId: string; onOpen: (r: Run) => void; more?: () => void }) {
  const versions = hasFeature('versions');
  const cols = ['200px', '200px', 'minmax(0, 1fr)', '200px', ...(versions ? ['110px'] : []), '90px', '24px'].join(' ');
  return (
    <div className="rp-history" role="table" aria-label="Run history" style={{ ['--rh-cols' as string]: cols }}>
      <div role="row" className="rh-row rh-th">
        <div role="columnheader">Result</div><div role="columnheader">When</div><div role="columnheader">Who</div>
        <div role="columnheader">Where</div>{versions && <div role="columnheader">Version</div>}<div role="columnheader">Took</div><div role="columnheader"><span className="sr-only">Open</span></div>
      </div>
      {runs.map(r => {
        const where = WHERE[r.source];
        return (
          <div role="row" key={r.id} tabIndex={0} className={`rh-row rh-tr${r.id === currentId ? ' current' : ''}`} aria-current={r.id === currentId || undefined}
            onClick={() => onOpen(r)} onKeyDown={e => { if (e.key === 'Enter') onOpen(r); }}>
            <div role="cell"><StatusPill status={runStatus(r)} /></div>
            <div role="cell" className="rh-2">{formatDateTime(r.startedAt)}</div>
            <div role="cell" className="rh-2 col rh-who">
              <span className="ellipsis">{runBy(r)}</span>
              {r.note && <span className="rh-note ellipsis" title={r.note}>{r.note}</span>}
            </div>
            <div role="cell" className="rh-where" title={r.machine}>
              <Icon name={where.icon} size={17} />
              <div className="col" style={{ minWidth: 0 }}><span>{where.label}</span><span className="rh-machine ellipsis">{r.machine}</span></div>
            </div>
            {versions && <div role="cell" className="rh-3">Version {r.testVersion}</div>}
            <div role="cell" className="rh-3">{tookText(r.durationMs)}</div>
            <Icon name="chevron_right" size={20} className="faint" />
          </div>
        );
      })}
      {more && <div className="rh-more"><Button kind="link" size="sm" onClick={more}>Show older runs</Button></div>}
    </div>
  );
}

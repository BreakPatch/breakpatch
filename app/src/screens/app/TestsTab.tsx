// Tests tab: search, filters, tally and the tests table (ui-requirements §5.4).
import { useMemo, useState, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Icon, IconButton, Menu, SharedChip, statusInfo, useToast } from '../../components/ui';
import {
  ConfirmDialog, FilterChip, RelativeTime, ResultTally, SearchBox, countResults, formatWhen, lastRunStatus, plural,
} from '../../components/common';
import { useBackend } from '../../data/hooks';
import type { App, Test } from '../../data/types';
import { useFeature } from '../../edition';
import { distinct, filterTests, type LastRunFilter, type SharedFilter } from './filters';
import { TestDetailsDialog } from './TestDetailsDialog';

// Community is one person with the latest version only: no Shared column, no people, no history.
// They follow the licence while the app runs (edition/features.ts).
function useCols() { const TEAM = useFeature('collaboration'); return { TEAM, HISTORY: useFeature('versions'), COLS: TEAM ? 'app-cols-tests' : 'app-cols-tests-solo' }; }

export function TestsTab({ app, tests }: { app: App; tests: Test[] }) {
  const { TEAM, COLS } = useCols();
  const [q, setQ] = useState('');
  const [shared, setShared] = useState<SharedFilter>('all');
  const [lastRun, setLastRun] = useState<LastRunFilter>('all');
  const [createdBy, setCreatedBy] = useState('all');
  const [deleting, setDeleting] = useState<Test | null>(null);
  const [editing, setEditing] = useState<Test | null>(null);
  const backend = useBackend();

  const creators = useMemo(() => distinct(tests.map(t => t.createdBy), p => p.uid), [tests]);
  const shown = filterTests(tests, { q, shared, lastRun, createdBy });
  const filtered = q || shared !== 'all' || lastRun !== 'all' || createdBy !== 'all';
  const clear = () => { setQ(''); setShared('all'); setLastRun('all'); setCreatedBy('all'); };

  return (
    <>
      <div className="app-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search tests" />
        {TEAM && <FilterChip name="Shared" allLabel="all" value={shared} onChange={setShared}
          options={[{ value: 'all', label: 'All tests' }, { value: 'published', label: 'In team suite' }, { value: 'draft', label: 'Only you' }]} />}
        <FilterChip name="Last run" allLabel="all" value={lastRun} onChange={setLastRun}
          options={[{ value: 'all', label: 'Any result' }, { value: 'passed', label: 'Passed' }, { value: 'fixed', label: 'Fixed automatically' }, { value: 'failed', label: 'Failed' }, { value: 'never', label: 'Never run' }]} />
        {TEAM && <FilterChip name="Created by" allLabel="anyone" value={createdBy} onChange={setCreatedBy}
          options={[{ value: 'all', label: 'Anyone' }, ...creators.map(p => ({ value: p.uid, label: p.name }))]} />}
        <div className="grow" />
        <ResultTally counts={countResults(tests)} />
      </div>
      <div className="app-table" role="table" aria-label="Tests">
        <div className={`app-row app-row-head ${COLS}`} role="row">
          <div role="columnheader">Name</div>{TEAM && <div role="columnheader">Shared</div>}<div role="columnheader">Last run</div>
          <div role="columnheader">Created</div><div role="columnheader">Last updated</div><div role="columnheader"><span className="sr-only">Actions</span></div>
        </div>
        {shown.map((t, i) => <TestRow key={t.id} app={app} test={t} index={i} onDelete={() => setDeleting(t)} onDetails={() => setEditing(t)} />)}
        {!shown.length && filtered && (
          <div className="app-nomatch">No tests match. <Button kind="link" size="sm" onClick={clear}>Clear filters</Button></div>
        )}
      </div>
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger confirmLabel="Delete test" title={`Delete "${deleting?.name ?? ''}"?`}
        onConfirm={async () => { if (deleting) await backend.deleteTest(app.id, deleting.id); }}>
        {TEAM ? "It's removed for everyone, with its version history." : "It's removed from this Mac."} Past runs stay in the Runs tab.
      </ConfirmDialog>
      {editing && <TestDetailsDialog open test={tests.find(t => t.id === editing.id) ?? editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TestRow({ app, test: t, index, onDelete, onDetails }: { app: App; test: Test; index: number; onDelete: () => void; onDetails: () => void }) {
  const { TEAM, HISTORY, COLS } = useCols();
  const navigate = useNavigate();
  const backend = useBackend();
  const toast = useToast();
  const [menu, setMenu] = useState(false);
  const base = `/apps/${app.id}/tests/${t.id}`;
  const st = statusInfo(lastRunStatus(t.lastRun));
  const open = () => navigate(`${base}/record`);
  const stop = (e: SyntheticEvent) => e.stopPropagation();

  const duplicate = async () => {
    try { const c = await backend.duplicateTest(app.id, t.id); toast(`Duplicated as "${c.name}"`); }
    catch (e) { toast(e instanceof Error ? e.message : "Couldn't duplicate the test", { error: true }); }
  };

  return (
    <div className={`app-row ${COLS} clickable`} role="row" tabIndex={0} aria-label={`${t.name}, open in the recorder`}
      style={{ animationDelay: `${Math.min(index, 12) * 25}ms` }}
      onClick={open} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }}>
      <div role="cell" className="app-cell-2">
        <div className="app-name ellipsis">{t.name}</div>
        <div className="app-meta">{plural(t.stepCount, 'step')}</div>
      </div>
      {TEAM && <div role="cell"><SharedChip published={t.status === 'published'} /></div>}
      <div role="cell" className="app-cell-2">
        <div className="app-result" style={{ color: st.color }}><Icon name={st.icon} size={17} />{st.word}</div>
        <div className="app-meta">{t.lastRun ? formatWhen(t.lastRun.at) : 'No runs yet'}</div>
      </div>
      <div role="cell" className="app-cell-2">
        {TEAM && <div className="app-person ellipsis">{t.createdBy.name}</div>}
        <RelativeTime className={TEAM ? 'app-meta' : 'app-text2'} ts={t.createdAt} kind="day" />
      </div>
      <div role="cell" className="app-cell-2">
        {TEAM && <div className="app-person ellipsis">{t.updatedBy.name}</div>}
        <RelativeTime className={TEAM ? 'app-meta' : 'app-text2'} ts={t.updatedAt} kind="updated" />
      </div>
      <div role="cell" className="app-actions" onClick={stop} onKeyDown={stop}>
        <button type="button" className="app-run-btn" aria-label={`Run ${t.name}`} title="Run" onClick={() => navigate(`${base}/run`)}><Icon name="play_arrow" size={19} /></button>
        {HISTORY && <IconButton icon="history" label="Version history" size={19} onClick={() => navigate(`${base}/history`)} />}
        <div className="cm-rel">
          <IconButton icon="more_vert" label={`More for ${t.name}`} size={19} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)} />
          <Menu open={menu} onClose={() => setMenu(false)} label={`${t.name} actions`} width={200} style={{ top: 'calc(100% + 4px)', right: 0 }}
            items={[
              { label: 'Edit steps', icon: 'edit', onSelect: open },
              { label: 'Test details', icon: 'description', onSelect: onDetails },
              { label: 'Duplicate', icon: 'content_copy', onSelect: duplicate },
              ...(HISTORY ? [{ label: 'View history', icon: 'history', onSelect: () => navigate(`${base}/history`) }] : []),
              'sep',
              { label: 'Delete', icon: 'delete', danger: true, onSelect: onDelete },
            ]} />
        </div>
      </div>
    </div>
  );
}

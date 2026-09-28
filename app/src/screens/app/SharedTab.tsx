// Shared steps tab: groups of steps several tests reuse (ui-requirements §5.8).
import { useState, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, IconButton, Menu } from '../../components/ui';
import { ImpactDialog, RelativeTime, SearchBox, plural } from '../../components/common';
import type { App, StepGroup, Test } from '../../data/types';
import { useFeature } from '../../edition';

// Community keeps the latest version only and has one person: no Version column, no names, no history.
// They follow the licence while the app runs (edition/features.ts).
function useCols() { const HISTORY = useFeature('versions'); return { HISTORY, TEAM: useFeature('collaboration'), COLS: HISTORY ? 'app-cols-shared' : 'app-cols-shared-solo' }; }

export function SharedTab({ app, groups, tests }: { app: App; groups: StepGroup[]; tests: Test[] }) {
  const { HISTORY, COLS } = useCols();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<StepGroup | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = groups.filter(g => !needle || g.name.toLowerCase().includes(needle) || g.description?.toLowerCase().includes(needle));
  const editPath = (g: StepGroup) => `/apps/${app.id}/shared/${g.id}/edit`;
  const edit = (g: StepGroup) => (g.usedBy.length ? setEditing(g) : navigate(editPath(g)));

  return (
    <>
      <div className="app-toolbar">
        <SearchBox value={q} onChange={setQ} placeholder="Search shared steps" />
        <div className="grow" />
        <div className="app-toolbar-note">Steps several tests repeat, like logging in.</div>
      </div>
      <div className="app-table" role="table" aria-label="Shared steps">
        <div className={`app-row app-row-head ${COLS}`} role="row">
          <div role="columnheader">Name</div><div role="columnheader">Steps</div><div role="columnheader">Used by</div>
          {HISTORY && <div role="columnheader">Version</div>}<div role="columnheader">Last updated</div><div role="columnheader"><span className="sr-only">Actions</span></div>
        </div>
        {shown.map((g, i) => <GroupRow key={g.id} app={app} group={g} index={i} onEdit={() => edit(g)} />)}
        {!shown.length && <div className="app-nomatch">No shared steps match "{q}".</div>}
      </div>
      <ImpactDialog open={!!editing} group={editing} tests={tests} onClose={() => setEditing(null)}
        onContinue={() => { const g = editing; setEditing(null); if (g) navigate(editPath(g)); }} />
    </>
  );
}

function GroupRow({ app, group: g, index, onEdit }: { app: App; group: StepGroup; index: number; onEdit: () => void }) {
  const { HISTORY, TEAM, COLS } = useCols();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const history = () => navigate(`/apps/${app.id}/shared/${g.id}/history`);
  return (
    <div className={`app-row ${COLS} clickable app-row-tall`} role="row" tabIndex={0} aria-label={`${g.name}, edit`}
      style={{ animationDelay: `${index * 25}ms` }}
      onClick={onEdit} onKeyDown={e => { if (e.key === 'Enter' && e.target === e.currentTarget) onEdit(); }}>
      <div role="cell" className="row" style={{ gap: 12, minWidth: 0 }}>
        <span className="app-disc"><Icon name="account_tree" size={18} /></span>
        <div className="app-cell-2">
          <div className="app-name ellipsis">{g.name}</div>
          {g.description && <div className="app-desc ellipsis">{g.description}</div>}
        </div>
      </div>
      <div role="cell" className="app-plain">{g.stepCount}</div>
      <div role="cell" className="app-used"><Icon name="checklist" size={17} />{plural(g.usedBy.length, 'test')}</div>
      {HISTORY && <div role="cell" className="app-plain">{g.currentVersion}</div>}
      <div role="cell" className="app-cell-2">
        {TEAM && <div className="app-person ellipsis">{g.updatedBy.name}</div>}
        <RelativeTime className={TEAM ? 'app-meta' : 'app-text2'} ts={g.updatedAt} kind="updated" />
      </div>
      <div role="cell" className="app-actions" onClick={stop} onKeyDown={stop}>
        <button type="button" className="app-run-btn" aria-label={`Edit ${g.name}`} title="Edit" onClick={onEdit}><Icon name="edit" size={18} /></button>
        <div className="cm-rel">
          <IconButton icon="more_vert" label={`More for ${g.name}`} size={19} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(m => !m)} />
          <Menu open={menu} onClose={() => setMenu(false)} label={`${g.name} actions`} width={200} style={{ top: 'calc(100% + 4px)', right: 0 }}
            items={[{ label: 'Edit', icon: 'edit', onSelect: onEdit }, ...(HISTORY ? [{ label: 'Version history', icon: 'history', onSelect: history }] : [])]} />
        </div>
      </div>
    </div>
  );
}

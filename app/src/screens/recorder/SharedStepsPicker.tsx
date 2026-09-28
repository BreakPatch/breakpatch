// "Insert shared steps": pick a group from the library, then "Always latest" or keep the current version.
import { useEffect, useRef, useState } from 'react';
import type { StepGroup } from '../../data/types';
import { useLive } from '../../data/hooks';
import { Button, Icon, IconButton, Skeleton, TextInput } from '../../components/ui';

export function SharedStepsPicker({ appId, insertAs, onInsert, onBack, onClose }: {
  appId: string;
  /** Row number the new card gets ("Insert as step 9"). */
  insertAs: number;
  onInsert: (g: StepGroup, version: number | 'latest') => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const { data: groups } = useLive<StepGroup[]>((b, l) => b.stepGroups(appId, l), [appId]);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string | null>(null);
  const [latest, setLatest] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const list = (groups ?? []).filter(g => (g.name + ' ' + (g.description ?? '')).toLowerCase().includes(q.toLowerCase()));
  const picked = groups?.find(g => g.id === (sel ?? list[0]?.id));

  useEffect(() => {
    const el = ref.current;
    el?.querySelector<HTMLElement>('input')?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onDown = (e: MouseEvent) => { if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.rec-action-btn')) onClose(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('mousedown', onDown);
    return () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('mousedown', onDown); };
  }, [onClose]);

  return (
    <div ref={ref} className="rec-picker" role="dialog" aria-label="Insert shared steps">
      <div className="rec-picker-head">
        <IconButton icon="arrow_back" label="Back to actions" onClick={onBack} />
        <div className="grow rec-picker-title">Insert shared steps</div>
        <IconButton icon="close" label="Close" onClick={onClose} />
      </div>
      <TextInput leadIcon="search" placeholder="Search shared steps" value={q} onChange={e => setQ(e.target.value)} aria-label="Search shared steps" />
      <div className="rec-picker-list" role="listbox" aria-label="Shared steps">
        {!groups && [0, 1, 2].map(i => <Skeleton key={i} h={52} r={8} />)}
        {groups && list.length === 0 && <div className="faint" style={{ padding: 10, fontSize: 13 }}>{groups.length ? 'No shared steps match.' : 'No shared steps yet. Record steps you repeat, like logging in, once.'}</div>}
        {list.map(g => {
          const on = picked?.id === g.id;
          return (
            <button key={g.id} type="button" role="option" aria-selected={on} className={'rec-group' + (on ? ' on' : '')} onClick={() => setSel(g.id)}
              onDoubleClick={() => onInsert(g, latest ? 'latest' : g.currentVersion)}>
              <span className="rec-group-disc"><Icon name="account_tree" size={18} /></span>
              <span className="grow col" style={{ gap: 2, minWidth: 0 }}><span className="rec-group-name">{g.name}</span>{g.description && <span className="rec-group-desc ellipsis">{g.description}</span>}</span>
              <span className="rec-group-meta"><span>{g.stepCount} steps</span><span>Used by {g.usedBy.length} {g.usedBy.length === 1 ? 'test' : 'tests'}</span></span>
            </button>
          );
        })}
      </div>
      {picked && (
        <>
          <div className="rec-picker-when">When "{picked.name}" is updated</div>
          <div className="rec-picker-modes" role="radiogroup" aria-label={`When ${picked.name} is updated`}>
            <Mode on={latest} onClick={() => setLatest(true)} title="Always latest" text="This test picks up changes automatically" />
            <Mode on={!latest} onClick={() => setLatest(false)} title={`Keep version ${picked.currentVersion}`} text="Stays as it is now until you change it" />
          </div>
          <div className="row" style={{ gap: 10 }}>
            <Button kind="primary" icon="add" onClick={() => onInsert(picked, latest ? 'latest' : picked.currentVersion)}>Insert as step {insertAs}</Button>
          </div>
        </>
      )}
    </div>
  );
}

function Mode({ on, onClick, title, text }: { on: boolean; onClick: () => void; title: string; text: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} className={'rec-mode' + (on ? ' on' : '')} onClick={onClick}>
      <span className="rec-radio">{on && <span />}</span>
      <span className="col" style={{ gap: 2, alignItems: 'flex-start', textAlign: 'left' }}><span className="rec-mode-title">{title}</span><span className="rec-mode-text">{text}</span></span>
    </button>
  );
}

import { useState } from 'react';
import { Icon, IconButton, Menu, Skeleton, type MenuEntry } from '../../components/ui';
import { ResultChips, countResults, hostOf, lastRunLine, latestRun, plural } from '../../components/common';
import type { App, Test } from '../../data/types';

export function AppCard({ app, tests, canDelete, onOpen, onEdit, onDelete, index }: {
  app: App; tests: Test[] | undefined; canDelete: boolean; index: number;
  onOpen: () => void; onEdit: () => void; onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const items: MenuEntry[] = [{ label: 'Edit app', icon: 'edit', onSelect: onEdit }];
  if (canDelete) items.push('sep', { label: 'Delete app', icon: 'delete', danger: true, onSelect: onDelete });

  return (
    <div className="home-card" role="link" tabIndex={0} aria-label={`Open ${app.name}`} style={{ animationDelay: `${index * 40}ms` }}
      onClick={onOpen} onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); onOpen(); } }}>
      <div className="home-card-head">
        <span className="home-disc"><Icon name={app.icon ?? 'language'} size={22} /></span>
        <div className="grow col" style={{ gap: 3 }}>
          <div className="home-card-name ellipsis">{app.name}</div>
          <div className="home-card-url mono ellipsis">{hostOf(app.baseUrl)}</div>
        </div>
        <div className="cm-rel" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
          <IconButton icon="more_vert" label={`More for ${app.name}`} onClick={() => setMenu(m => !m)} aria-haspopup="menu" aria-expanded={menu} />
          <Menu open={menu} onClose={() => setMenu(false)} items={items} label={`${app.name} actions`} width={200} style={{ top: 'calc(100% + 4px)', right: 0 }} />
        </div>
      </div>
      {tests ? (
        <>
          <div className="home-card-count"><Icon name="checklist" size={17} />{plural(tests.length, 'test')}</div>
          <ResultChips counts={countResults(tests)} />
          <div className="home-card-foot">{lastRunLine(latestRun(tests))}</div>
        </>
      ) : (
        <>
          <Skeleton w="30%" h={12} />
          <div className="row"><Skeleton w={80} h={22} r={100} /><Skeleton w={64} h={22} r={100} /></div>
          <div className="home-card-foot"><Skeleton w="55%" h={10} /></div>
        </>
      )}
    </div>
  );
}

export function AppCardSkeleton({ delay }: { delay: number }) {
  return (
    <div className="home-card home-card-skel" aria-hidden style={{ animationDelay: `${delay}ms` }}>
      <div className="home-card-head">
        <Skeleton w={44} h={44} r={22} />
        <div className="grow col" style={{ gap: 8 }}><Skeleton w="60%" h={14} r={4} /><Skeleton w="40%" h={10} r={4} /></div>
      </div>
      <Skeleton w="30%" h={10} r={4} />
      <div className="row"><Skeleton w={80} h={22} r={100} /><Skeleton w={64} h={22} r={100} /></div>
    </div>
  );
}

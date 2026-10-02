// Settings → Recently deleted: deleted apps, tests, shared steps and suites, for 30 days
// (Backend.recentlyDeleted). Restore puts one back; Delete now deletes it for good.
import { useState } from 'react';
import { Button, Icon, IconButton, Skeleton, useToast } from '../../../components/ui';
import { formatDateTime } from '../../../components/common/format';
import { KEEP_DELETED_DAYS, canManageDeleted, daysLeft, type DeletedItem, type DeletedKind } from '../../../data/backend';
import { useBackend, useLive } from '../../../data/hooks';
import { useFeature } from '../../../edition/features';
import { useSession } from '../../../state/session';
import { Confirm, Section } from './common';

const KIND: Record<DeletedKind, { icon: string; word: string }> = {
  app: { icon: 'language', word: 'App' },
  test: { icon: 'radio_button_checked', word: 'Test' },
  group: { icon: 'account_tree', word: 'Shared steps' },
  suite: { icon: 'playlist_play', word: 'Suite' },
};

/** What else goes when it's deleted for good. */
function forGood(i: DeletedItem, history: boolean): string {
  if (i.kind === 'app') return `Its tests, shared steps${history ? ', version history' : ''} and runs go too. This can't be undone.`;
  if (i.kind === 'suite') return "This can't be undone. Its past runs stay in the history.";
  return history ? "Its version history goes too. This can't be undone." : "This can't be undone.";
}

export const itemKey = (i: DeletedItem) => `${i.kind}/${i.appId ?? ''}/${i.id}/${i.deletedAt}`;

/** The section is there for every backend with a Recently deleted (all of them, so far). */
export function useDeletedVisible() { return useSession(s => !!s.backend?.recentlyDeleted); }

export function DeletedSection() {
  const backend = useBackend();
  const toast = useToast();
  const TEAM = useFeature('collaboration');
  const HISTORY = useFeature('versions');
  const user = useSession(s => s.user);
  const { data: items } = useLive<DeletedItem[]>((b, l) => b.recentlyDeleted?.items(l) ?? (l([]), () => {}), []);
  const [busy, setBusy] = useState<string | null>(null);
  const [purging, setPurging] = useState<DeletedItem | null>(null);
  const role = backend.myRole();

  const restore = async (i: DeletedItem) => {
    setBusy(itemKey(i));
    try { await backend.recentlyDeleted!.restore(i); toast(`${i.name} restored.`); }
    catch (e) { toast(e instanceof Error ? e.message : `Couldn't restore ${i.name}.`, { error: true }); }
    finally { setBusy(null); }
  };
  const purge = async (i: DeletedItem) => {
    try { await backend.recentlyDeleted!.deleteNow(i); toast(`${i.name} deleted for good.`); }
    catch (e) { toast(e instanceof Error ? e.message : `Couldn't delete ${i.name}.`, { error: true }); }
  };

  return (
    <Section title="Recently deleted">
      <p className="set-lead">
        Deleted apps, tests, shared steps and suites stay here for {KEEP_DELETED_DAYS} days{TEAM ? ' for everyone in the workspace' : ''}. Then they're deleted for good.
      </p>

      <div className="set-list" role="list" aria-label="Recently deleted">
        {!items && [0, 1].map(i => <div key={i} className="set-del"><Skeleton w={19} h={19} r={10} /><div className="grow col" style={{ gap: 6 }}><Skeleton w={200} /><Skeleton w={260} h={10} /></div></div>)}
        {items?.length === 0 && <div className="set-del"><span className="set-del-empty">Nothing deleted in the last {KEEP_DELETED_DAYS} days.</span></div>}
        {items?.map(i => {
          const k = KIND[i.kind];
          const allowed = canManageDeleted(i, role, user?.uid);
          const left = daysLeft(i.deletedAt);
          const why = allowed ? undefined : 'Only admins can restore this';
          return (
            <div key={itemKey(i)} className="set-del" role="listitem">
              <Icon name={k.icon} />
              <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
                <div className="set-del-name ellipsis">{i.name}</div>
                <div className="set-del-meta ellipsis">
                  {[i.appName ? `${k.word} in ${i.appName}` : k.word,
                    `Deleted ${formatDateTime(i.deletedAt)}${TEAM ? ` by ${i.deletedBy.name}` : ''}`,
                    left ? `${left} ${left === 1 ? 'day' : 'days'} left` : 'Last day'].join(' · ')}
                </div>
              </div>
              <Button size="sm" icon="restore" busy={busy === itemKey(i)} disabled={!allowed} title={why} onClick={() => void restore(i)}>Restore</Button>
              <IconButton icon="delete" label={`Delete ${i.name} now`} disabled={!allowed} title={why ?? 'Delete now'} onClick={() => setPurging(i)} />
            </div>
          );
        })}
      </div>

      <Confirm open={!!purging} onClose={() => setPurging(null)} icon="delete"
        title={`Delete ${purging ? `"${purging.name}"` : 'it'} now?`} confirm="Delete now"
        text={purging ? forGood(purging, HISTORY) : ''}
        onConfirm={() => (purging ? purge(purging) : undefined)} />
    </Section>
  );
}

// Home: the apps under test (README "2 · Home and tests", ui-requirements §5.3, §5.18).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppFrame } from '../../components/shell/AppFrame';
import { OfflineCards } from '../../components/shell/SystemBanners';
import { Button, Icon, Skeleton, useToast } from '../../components/ui';
import { ConfirmDialog, plural } from '../../components/common';
import { useBackend, useLive } from '../../data/hooks';
import { KEEP_DELETED_DAYS } from '../../data/backend';
import type { App } from '../../data/types';
import { useSession } from '../../state/session';
import { edition } from '../../edition';
import { firstNameOf } from '../../data/local/folder';
import { AppCard, AppCardSkeleton } from './AppCard';
import { AppDialog } from './AppDialog';
import { FirstUse } from './FirstUse';
import { useAllTests } from './useAllTests';
import './home.css';
import { ariaShortcut } from '../../lib/osWords';

/** The edition's line above the apps (Team: "Upgrade to Team" while a tests folder is open). */
const HomeBanner = edition.slots.homeBanner;

export default function HomeScreen() {
  const navigate = useNavigate();
  const backend = useBackend();
  const toast = useToast();
  const user = useSession(s => s.user);
  const { data: apps, slow } = useLive<App[]>((b, l) => b.apps(l), []);
  const testsByApp = useAllTests(apps);
  const isAdmin = backend.myRole() === 'admin';

  const [dialog, setDialog] = useState<{ app: App | null } | null>(null);
  const [deleting, setDeleting] = useState<App | null>(null);

  const allLoaded = !!apps && apps.every(a => testsByApp[a.id]);
  const totalTests = useMemo(() => Object.values(testsByApp).reduce((n, t) => n + t.length, 0), [testsByApp]);
  const firstUse = !!apps && (apps.length === 0 || (allLoaded && totalTests === 0));

  const addApp = () => setDialog({ app: null });
  const openApp = (a: App) => navigate(`/apps/${a.id}`);

  return (
    <AppFrame nav="apps" actions={!firstUse && <Button icon="add" aria-keyshortcuts={ariaShortcut('N')} onClick={addApp}>Add app</Button>}>
      {!apps ? (
        <div className="page home-page" aria-busy="true">
          <Skeleton w={120} h={26} />
          <div className="home-grid">{[0, 150, 300].map(d => <AppCardSkeleton key={d} delay={d} />)}</div>
          {slow && <div className="home-slow" role="status"><Icon name="hourglass_top" size={17} />Still loading. Your connection may be slow.</div>}
        </div>
      ) : firstUse ? (
        <div className="home-first-wrap">
          {HomeBanner && <div className="home-banner"><HomeBanner /></div>}
          <FirstUse workspace={backend.workspace?.name} firstName={firstNameOf(user)} hasApp={apps.length > 0}
            onAddApp={addApp} onNewTest={() => navigate(`/apps/${apps[0].id}?new`)} />
        </div>
      ) : (
        <div className="page home-page">
          {HomeBanner && <HomeBanner />}
          <div className="home-head">
            <h2 className="page-title">Apps</h2>
            <div className="home-head-note">Last results from each test's most recent run</div>
          </div>
          <div className="home-grid">
            {apps.map((a, i) => (
              <AppCard key={a.id} app={a} index={i} tests={testsByApp[a.id]} canDelete={isAdmin}
                onOpen={() => openApp(a)} onEdit={() => setDialog({ app: a })} onDelete={() => setDeleting(a)} />
            ))}
            <button type="button" className="home-add" onClick={addApp}><Icon name="add" size={28} />Add an app to test</button>
          </div>
          <OfflineCards />
        </div>
      )}

      <AppDialog open={!!dialog} app={dialog?.app} onClose={() => setDialog(null)} />
      <ConfirmDialog open={!!deleting} onClose={() => setDeleting(null)} danger confirmLabel="Delete app"
        title={`Delete ${deleting?.name ?? 'app'}?`}
        onConfirm={async () => {
          if (!deleting) return;
          try { await backend.deleteApp(deleting.id); toast(`${deleting.name} moved to Recently deleted.`); }
          catch (e) { toast(e instanceof Error ? e.message : "Couldn't delete the app.", { error: true }); }
        }}>
        {deleting && `It goes to Recently deleted with its ${plural(testsByApp[deleting.id]?.length ?? 0, 'test')}, shared steps and runs${backend.workspace ? ', for everyone' : ''}. You can restore it there for ${KEEP_DELETED_DAYS} days.`}
      </ConfirmDialog>
    </AppFrame>
  );
}

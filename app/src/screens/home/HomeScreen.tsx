// Home: the apps under test (README "2 · Home and tests", ui-requirements §5.3, §5.18).
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppFrame } from '../../components/shell/AppFrame';
import { OfflineCards } from '../../components/shell/SystemBanners';
import { Button, Icon, Skeleton } from '../../components/ui';
import { plural, useMoveToBin } from '../../components/common';
import { useBackend, useLive } from '../../data/hooks';
import type { App } from '../../data/types';
import { useSession } from '../../state/session';
import { edition } from '../../edition';
import { firstNameOf } from '../../data/local/folder';
import { AppCard, AppCardSkeleton } from './AppCard';
import { AppDialog } from './AppDialog';
import { FirstUse } from './FirstUse';
import { useAllTests } from './useAllTests';
import './home.css';

/** The edition's line above the apps (Team: "Upgrade to Team" while a tests folder is open). */
const HomeBanner = edition.slots.homeBanner;

export default function HomeScreen() {
  const navigate = useNavigate();
  const backend = useBackend();
  const user = useSession(s => s.user);
  const { data: apps, slow } = useLive<App[]>((b, l) => b.apps(l), []);
  const testsByApp = useAllTests(apps);
  const isAdmin = backend.myRole() === 'admin';

  const [dialog, setDialog] = useState<{ app: App | null } | null>(null);
  const moveToBin = useMoveToBin();
  // Straight to Recently deleted, with its tests, and Undo in the toast (moveToBin.ts).
  const remove = (a: App) => {
    const n = testsByApp[a.id]?.length ?? 0;
    void moveToBin({ kind: 'app', id: a.id }, a.name, () => backend.deleteApp(a.id), "Couldn't delete the app.",
      `"${a.name}"${n ? ` and its ${plural(n, 'test')}` : ''} moved to Recently deleted.`);
  };

  const allLoaded = !!apps && apps.every(a => testsByApp[a.id]);
  const totalTests = useMemo(() => Object.values(testsByApp).reduce((n, t) => n + t.length, 0), [testsByApp]);
  const firstUse = !!apps && (apps.length === 0 || (allLoaded && totalTests === 0));

  const addApp = () => setDialog({ app: null });
  const openApp = (a: App) => navigate(`/apps/${a.id}`);

  return (
    <AppFrame nav="apps" actions={!firstUse && <Button icon="add" aria-keyshortcuts="Meta+N" onClick={addApp}>Add app</Button>}>
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
                onOpen={() => openApp(a)} onEdit={() => setDialog({ app: a })} onDelete={() => remove(a)} />
            ))}
            <button type="button" className="home-add" onClick={addApp}><Icon name="add" size={28} />Add an app to test</button>
          </div>
          <OfflineCards />
        </div>
      )}

      <AppDialog open={!!dialog} app={dialog?.app} onClose={() => setDialog(null)} />
    </AppFrame>
  );
}

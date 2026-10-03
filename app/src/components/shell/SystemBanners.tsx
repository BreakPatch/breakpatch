// Banners under the title bar, never blocking (design "System States").
import type { ReactNode } from 'react';
import { Button, Icon } from '../ui';
import { useSession } from '../../state/session';
import { useSystem } from '../../state/system';
import { checkForUpdates, restartToUpdate } from '../../lib/updates';
import './systemStates.css';
import { osText } from '../../lib/osWords';

/** One banner under the title bar; editions reuse it (Team: the licence banner). */
export function SysBanner({ tone, icon, title, text, actions }: { tone: 'accent' | 'fixed'; icon: string; title: ReactNode; text: ReactNode; actions: ReactNode }) {
  return (
    <div className={`sys-banner ${tone}`} role="status">
      <Icon name={icon} />
      <div className="sys-banner-copy">
        <div className="sys-banner-title">{title}</div>
        <div className="sys-banner-text">{text}</div>
      </div>
      <div className="sys-banner-actions">{actions}</div>
    </div>
  );
}

export function SystemBanners() {
  const online = useSession(s => s.online);
  // A tests folder on this Mac works the same offline; its files can be edited outside the app.
  const local = useSession(s => !!s.local);
  const { updateReady, updateDismissed, dismissUpdate, readOnly, warnings, warningsDismissed, dismissWarnings } = useSystem();
  return (
    <>
      {readOnly && (
        <SysBanner tone="fixed" icon="lock" title="Update Breakpatch to save changes."
          text={local ? 'This folder was saved by a newer Breakpatch.' : 'Someone on your team uses a newer version.'}
          actions={<Button kind="primary" className="sys-banner-btn" onClick={() => void checkForUpdates()}>Check for updates</Button>} />
      )}
      {warnings.length > 0 && !warningsDismissed && (
        <SysBanner tone="fixed" icon="warning"
          title={warnings.length === 1 ? "A file in your tests folder couldn't be read." : `${warnings.length} files in your tests folder couldn't be read.`}
          text={<>{warnings.slice(0, 3).map(w => <span key={w} className="sys-banner-line">{w}</span>)}{warnings.length > 3 && <span className="sys-banner-line">and {warnings.length - 3} more. Everything else works.</span>}</>}
          actions={<Button className="sys-banner-btn" onClick={dismissWarnings}>Dismiss</Button>} />
      )}
      {updateReady && !updateDismissed && (
        <SysBanner tone="accent" icon="system_update" title={`Breakpatch ${updateReady} is ready.`}
          text="Restart when it suits you. Runs in progress finish first."
          actions={<>
            <Button kind="primary" className="sys-banner-btn" onClick={() => void restartToUpdate()}>Restart to update</Button>
            <Button className="sys-banner-btn" onClick={dismissUpdate}>Later</Button>
          </>} />
      )}
      {!online && !local && (
        <SysBanner tone="fixed" icon="cloud_off" title="You're offline."
          text="You can keep running and recording. Saving waits until you're back online."
          actions={<Button className="sys-banner-btn" onClick={() => useSession.getState().setOnline(navigator.onLine)}>Try again</Button>} />
      )}
    </>
  );
}

/**
 * "Still works" / "Waits until you're back" cards for the offline state. Screens show
 * them in their body (Home, under the apps grid) while `useSession().online` is false.
 */
export function OfflineCards() {
  const online = useSession(s => s.online);
  const local = useSession(s => !!s.local);
  if (online || local) return null;
  return (
    <div className="sys-offline-cards">
      <div className="sys-offline-card">
        <div className="sys-offline-head"><Icon name="check_circle" style={{ color: 'var(--passed)' }} />Still works</div>
        <div className="sys-offline-text">{osText('Running tests saved on this Mac')}<br />Recording new steps<br />{osText('The AI assistant (it runs on this Mac)')}</div>
      </div>
      <div className="sys-offline-card">
        <div className="sys-offline-head"><Icon name="schedule" style={{ color: 'var(--fixed)' }} />Waits until you're back</div>
        <div className="sys-offline-text">Saving new versions<br />Seeing your team's changes<br />Uploading run results</div>
      </div>
    </div>
  );
}

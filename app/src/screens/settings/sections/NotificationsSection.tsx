// Settings → Notifications: local notifications when a run or suite finishes while Breakpatch is in
// the background. Schedules and the local runner (Team) use the same settings.
import { useEffect, useState } from 'react';
import { Button, Icon, Switch } from '../../../components/ui';
import { openExternal } from '../../../platform';
import { NOTIFY_DEFAULTS, notifyPermission, type Permission } from '../../../lib/notify';
import { useSession } from '../../../state/session';
import { Section } from './common';
import { currentOs, osText, thisComputer } from '../../../lib/osWords';

/** macOS System Settings, on the Notifications pane (the shell's open scope allows exactly this). */
export const NOTIFICATION_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.notifications';

/** The system's notification settings for this computer: the Mac's pane, Windows' Settings page
 *  (the shell's open scope allows each on its own system), or none on Linux, where each desktop
 *  has its own. */
export function notificationSettingsUrl(): string | null {
  const os = currentOs();
  return os === 'mac' ? NOTIFICATION_SETTINGS_URL : os === 'windows' ? 'ms-settings:notifications' : null;
}

export function NotificationsSection() {
  const prefs = useSession(s => s.prefs);
  const set = useSession(s => s.setPrefs);
  const failures = prefs.notifyFailures ?? NOTIFY_DEFAULTS.notifyFailures;
  const all = prefs.notifyAll ?? NOTIFY_DEFAULTS.notifyAll;
  const [perm, setPerm] = useState<Permission | null>(null);
  useEffect(() => { void notifyPermission(false).then(setPerm).catch(() => setPerm(null)); }, []);
  // Turned off in macOS: say so first, with the way to fix it, and show the switches as blocked
  // (they keep their setting for when macOS allows it again) (DES-09).
  const blocked = perm === 'denied';
  const settingsUrl = notificationSettingsUrl();
  const note = blocked ? <div className="set-blocked-note">{osText('Blocked by macOS')}</div> : null;
  return (
    <Section title="Notifications">
      <p className="set-lead" style={{ maxWidth: 560 }}>When a run finishes while Breakpatch is in the background, {thisComputer()} can tell you. Notifications stay on {thisComputer()}.</p>
      {blocked && (
        <div className="banner banner-fixed set-banner" role="status">
          <Icon name="block" />
          <div className="grow col" style={{ gap: 2 }}>
            <span className="banner-title">{osText("macOS isn't letting Breakpatch show notifications")}</span>
            <span className="banner-text">{osText('In System Settings, open Notifications, then Breakpatch, and turn on Allow notifications.')}</span>
          </div>
          {settingsUrl && <Button iconAfter="open_in_new" onClick={() => void openExternal(settingsUrl).catch(() => undefined)}>{osText('Open System Settings')}</Button>}
        </div>
      )}
      <div className={'set-toggle' + (blocked ? ' blocked' : '')}>
        <div className="grow col" style={{ gap: 4 }}>
          <div className="set-toggle-t">Failures</div>
          <div className="set-toggle-d">When a test or suite fails, for example "Log in failed at step 9, Click Close button".</div>
          {note}
        </div>
        <Switch checked={failures} onChange={v => set({ notifyFailures: v })} label="Failures" />
      </div>
      <div className={'set-toggle' + (blocked ? ' blocked' : '')}>
        <div className="grow col" style={{ gap: 4 }}>
          <div className="set-toggle-t">Every finished run</div>
          <div className="set-toggle-d">Also when it passes, for example "Smoke suite passed: 12 tests in 4 min".</div>
          {note}
        </div>
        <Switch checked={all} onChange={v => set({ notifyAll: v })} label="Every finished run" />
      </div>
      <p className="set-note">Schedules and the local runner use these settings too. Click a notification to open the run's report.</p>
    </Section>
  );
}

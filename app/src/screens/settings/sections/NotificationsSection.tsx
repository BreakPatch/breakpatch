// Settings → Notifications: local notifications when a run or suite finishes while Breakpatch is in
// the background. Schedules and the local runner (Team) use the same settings.
import { useEffect, useState } from 'react';
import { Switch } from '../../../components/ui';
import { NOTIFY_DEFAULTS, notifyPermission, type Permission } from '../../../lib/notify';
import { useSession } from '../../../state/session';
import { Section } from './common';

export function NotificationsSection() {
  const prefs = useSession(s => s.prefs);
  const set = useSession(s => s.setPrefs);
  const failures = prefs.notifyFailures ?? NOTIFY_DEFAULTS.notifyFailures;
  const all = prefs.notifyAll ?? NOTIFY_DEFAULTS.notifyAll;
  const [perm, setPerm] = useState<Permission | null>(null);
  useEffect(() => { void notifyPermission(false).then(setPerm).catch(() => setPerm(null)); }, []);
  return (
    <Section title="Notifications">
      <p className="set-lead" style={{ maxWidth: 560 }}>When a run finishes while Breakpatch is in the background, this Mac can tell you. Notifications stay on this Mac.</p>
      <div className="set-toggle">
        <div className="grow col" style={{ gap: 4 }}>
          <div className="set-toggle-t">Failures</div>
          <div className="set-toggle-d">When a test or suite fails, for example "Log in failed at step 9, Click Close button".</div>
        </div>
        <Switch checked={failures} onChange={v => set({ notifyFailures: v })} label="Failures" />
      </div>
      <div className="set-toggle">
        <div className="grow col" style={{ gap: 4 }}>
          <div className="set-toggle-t">Every finished run</div>
          <div className="set-toggle-d">Also when it passes, for example "Smoke suite passed: 12 tests in 4 min".</div>
        </div>
        <Switch checked={all} onChange={v => set({ notifyAll: v })} label="Every finished run" />
      </div>
      {perm === 'denied' && (
        <p className="set-note" role="status">macOS isn't letting Breakpatch show notifications. To turn them on, open System Settings, then Notifications, then Breakpatch, and turn on Allow notifications.</p>
      )}
      <p className="set-note">Schedules and the local runner use these settings too. Click a notification to open the run's report.</p>
    </Section>
  );
}

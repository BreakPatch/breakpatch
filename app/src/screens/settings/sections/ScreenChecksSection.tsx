// Settings → Screen checks: how runs on this Mac treat a test recorded on another kind of system
// (engine/PROTOCOL.md "Where a test was recorded"). Stored with the other run settings in prefs.
import { Button, Switch } from '../../../components/ui';
import { openExternal } from '../../../platform';
import { useSession } from '../../../state/session';
import { Section } from './common';

const MANUAL = 'https://breakpatch.dev/manual/#run-a-test-and-read-the-report';
export const ALLOW_DIFFERENCES = 'Allow for small differences between systems';

export function ScreenChecksSection() {
  const on = useSession(s => s.prefs.allowSystemDifferences);
  const set = useSession(s => s.setPrefs);
  return (
    <Section title="Screen checks">
      <p className="set-lead" style={{ maxWidth: 560 }}>Each step checks how the page looks and compares it with how it looked when the step was recorded. Tests work best when they're recorded and run on the same kind of machine.</p>
      <div className="set-toggle">
        <div className="grow col" style={{ gap: 4 }}>
          <div className="set-toggle-t">{ALLOW_DIFFERENCES}</div>
          <div className="set-toggle-d">A test recorded on another system or with another version of the test browser can show text a pixel off. With this on, its screen checks allow for that, and still fail when something really changed.</div>
        </div>
        <Switch checked={on} onChange={v => set({ allowSystemDifferences: v })} label={ALLOW_DIFFERENCES} />
      </div>
      <p className="set-note">This applies to runs on this Mac. <Button kind="link" size="sm" onClick={() => void openExternal(MANUAL)}>More in the manual</Button></p>
    </Section>
  );
}

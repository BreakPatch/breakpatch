// Settings → Privacy: what Breakpatch sends about how it's used (docs/manual.md "Privacy", on the
// Documentation page at breakpatch.dev/docs/).
// Community: anonymous daily totals, on unless turned off here. Team: counts go with the licence
// check. Either way only numbers, and the next report is shown here exactly as it would be sent.
import { useEffect, useState } from 'react';
import { Button, Switch } from '../../../components/ui';
import { edition } from '../../../edition';
import { pendingLine, usage, type UsageSettings } from '../../../lib/usage';
import { openExternal } from '../../../platform';
import { Section } from './common';

export const PRIVACY_DOCS = 'https://breakpatch.dev/docs/#privacy';

export function PrivacySection() {
  const [s, setS] = useState<UsageSettings | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { usage.settings().then(setS, () => {}); }, []);
  const community = edition.name === 'community';

  const toggle = async (on: boolean) => {
    setBusy(true);
    try { setS(await usage.setEnabled(on)); } finally { setBusy(false); }
  };

  return (
    <Section title="Privacy">
      {community ? <>
        <p className="set-lead">Breakpatch counts tests created and runs, as anonymous totals for all users. It helps us see that Breakpatch is used and what to work on.</p>
        <div className="set-toggle">
          <div className="grow col" style={{ gap: 3 }}>
            <div className="set-toggle-t">Share anonymous usage counts</div>
            <div className="set-toggle-d">
              {s?.turnedOffByEnv ? 'Off: BREAKPATCH_NO_USAGE is set on this Mac.' : 'Once a day while you use Breakpatch. Turning it off stops it at once and drops what hasn’t been sent.'}
            </div>
          </div>
          <Switch checked={!!s?.enabled} disabled={!s || busy || s.turnedOffByEnv} onChange={v => void toggle(v)} label="Share anonymous usage counts" />
        </div>
      </> : (
        <p className="set-lead">Breakpatch Team sends usage counts with the licence check, so your admin and Breakpatch can see how the licence is used: tests created and runs, per person or machine.</p>
      )}

      <div className="set-info" role="note">
        <div>
          <strong>What’s sent</strong>
          <ul className="set-privacy-list">
            <li>How many tests were created, and how many runs {community ? 'there were' : 'by hand, by schedules, on the local runner and in CI'}, passed and failed.</li>
            {community
              ? <li>Whether it’s the first time today, this week or this month that Breakpatch on this Mac has sent them, and whether it’s the first time ever. That’s how active Macs are counted without any ID.</li>
              : <li>On how many days Breakpatch was used.</li>}
            <li>{community ? 'The app version.' : 'Nothing else: the licence check already knows the licence and seat.'}</li>
          </ul>
          <strong>Never sent</strong>
          <p className="set-note">Test names, addresses, steps, screenshots, saved secrets, your name or email, or any ID for you or this Mac{community ? '. Your IP address is only used to limit how often a Mac can send, and isn’t kept.' : '.'}</p>
        </div>
      </div>

      {s && (s.enabled || !community) && <p className="set-note" data-testid="usage-pending">Waiting to be sent: {pendingLine(s.pending)}</p>}
      <p className="set-note">{community ? 'You can also turn it off with the environment variable BREAKPATCH_NO_USAGE=1. ' : ''}<Button kind="link" size="sm" onClick={() => void openExternal(PRIVACY_DOCS)}>More in the documentation</Button></p>
    </Section>
  );
}

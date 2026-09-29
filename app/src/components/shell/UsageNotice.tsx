// Community's one-time notice about the anonymous usage counts (docs/manual.md "Privacy"), shown
// once the app is open (after Welcome and Setup). Nothing is sent before it has been shown. It's a
// notice in the corner, not a dialog: it blocks nothing and takes no focus (DES-10), so it counts
// as seen as soon as it shows. OK puts it away and counting goes on; Turn off stops it and drops
// what's waiting. Settings → Privacy changes it later.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Icon } from '../ui';
import { usePresence } from '../ui/presence';
import { edition } from '../../edition';
import { usage } from '../../lib/usage';
import './systemStates.css';

export const NOTICE_TEXT = 'Breakpatch counts tests created and runs, as anonymous totals for all users. No names, addresses, screenshots or IDs are sent.';

/** Screens the notice waits behind: the first-launch steps. */
const NOT_ON = ['/welcome', '/setup', ...edition.gate.paths];

export function UsageNotice() {
  const { pathname } = useLocation();
  const [show, setShow] = useState(false);
  const asked = useRef(false);
  const community = edition.name === 'community';
  const waiting = NOT_ON.includes(pathname);
  const { mounted, closing } = usePresence(show);

  useEffect(() => {
    if (!community || waiting || asked.current) return;
    asked.current = true;
    usage.settings().then(s => {
      if (s.edition !== 'community' || s.noticeSeen || s.turnedOffByEnv) return;
      setShow(true);
      void usage.noticeSeen();          // shown: sending may start (usage.rs), whether or not OK is pressed
    }, () => {});
  }, [community, waiting]);

  if (!mounted) return null;
  const ok = () => setShow(false);
  const off = () => { setShow(false); void usage.setEnabled(false); };
  return (
    <aside className={'usage-notice' + (closing ? ' closing' : '')} role="status" aria-label="Anonymous usage counts" inert={closing || undefined}>
      <div className="usage-notice-head"><Icon name="query_stats" size={20} /><span>Anonymous usage counts</span></div>
      <p className="usage-notice-text">{NOTICE_TEXT}</p>
      <p className="usage-notice-note">You can turn this off at any time in Settings → Privacy.</p>
      <div className="usage-notice-actions">
        <Button kind="ghost" size="sm" onClick={off}>Turn off</Button>
        <Button kind="primary" size="sm" onClick={ok}>OK</Button>
      </div>
    </aside>
  );
}

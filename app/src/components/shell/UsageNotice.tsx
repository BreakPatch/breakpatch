// Community's one-time notice about the anonymous usage counts (docs/manual.md "Privacy"), shown
// once the app is open (after Welcome and Setup). Nothing is sent before it has been shown. OK or
// closing it keeps counting on; Turn off stops it and drops what's waiting. Settings → Privacy
// changes it later.
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, Dialog } from '../ui';
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

  useEffect(() => {
    if (!community || waiting || asked.current) return;
    asked.current = true;
    usage.settings().then(s => setShow(s.edition === 'community' && !s.noticeSeen && !s.turnedOffByEnv), () => {});
  }, [community, waiting]);

  if (!show) return null;
  const ok = () => { setShow(false); void usage.noticeSeen(); };
  const off = () => { setShow(false); void usage.setEnabled(false); };
  return (
    <Dialog open onClose={ok} icon="query_stats" title="Anonymous usage counts" width={480}
      actions={<>
        <Button kind="ghost" onClick={off}>Turn off</Button>
        <Button kind="primary" onClick={ok}>OK</Button>
      </>}>
      <p className="usage-notice-text">{NOTICE_TEXT}</p>
      <p className="usage-notice-note">You can turn this off at any time in Settings → Privacy.</p>
    </Dialog>
  );
}

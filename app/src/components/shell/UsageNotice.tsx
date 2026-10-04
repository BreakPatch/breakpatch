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
/** Screens with their own bar along the bottom (the recorder's add-step bar, a run's controls): the
 *  notice steps aside there and comes back after, so it never covers them. */
const BUSY = /\/(record|run|run-all|edit)$|\/runs\//;

export function UsageNotice() {
  const { pathname } = useLocation();
  const [show, setShow] = useState(false);
  const asked = useRef(false);
  const community = edition.name === 'community';
  const waiting = NOT_ON.includes(pathname);
  const aside = BUSY.test(pathname);
  const { mounted, closing } = usePresence(show && !aside);
  const box = useRef<HTMLElement>(null);
  // While it shows, lists get room at their end (shell.css), so their last row can scroll clear of it.
  useEffect(() => {
    const el = box.current, root = document.documentElement;
    if (!mounted || closing || !el) return;
    const room = () => root.style.setProperty('--usage-notice-room', `${el.offsetHeight + 28}px`);
    room();
    root.classList.add('usage-notice-open');
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(room) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); root.classList.remove('usage-notice-open'); root.style.removeProperty('--usage-notice-room'); };
  }, [mounted, closing]);

  useEffect(() => {
    if (!community || waiting || aside || asked.current) return;
    asked.current = true;
    usage.settings().then(s => {
      if (s.edition !== 'community' || s.noticeSeen || s.turnedOffByEnv) return;
      setShow(true);
      void usage.noticeSeen();          // shown: sending may start (usage.rs), whether or not OK is pressed
    }, () => {});
  }, [community, waiting, aside]);

  if (!mounted) return null;
  const ok = () => setShow(false);
  const off = () => { setShow(false); void usage.setEnabled(false); };
  return (
    <aside ref={box} className={'usage-notice' + (closing ? ' closing' : '')} role="status" aria-label="Anonymous usage counts" inert={closing || undefined}>
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

// breakpatch://open links (lib/openLinks.ts, public roadmap #32): a link to a test or a suite opens
// it in its workspace. Switching to that workspace goes the way the switcher does (home, the
// recorder's browser closed, the other workspace opened), and only when switching is allowed (the
// edition's lock: Team's runner Mac stays in its workspace) and nothing is being recorded or run
// here. Once the workspace is open and its person signed in (a Team workspace may ask first), the
// test opens in the recorder, or the suite in its editor. A plain message says why when it can't.
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { create } from 'zustand';
import { edition } from '../../edition';
import { readFolderId } from '../../data/local/folder';
import { BAD_LINK, isOpenLink, parseOpenLink, resolveOpenLink, routeOf } from '../../lib/openLinks';
import { onWorkspaceLink } from '../../platform';
import { useConnections } from '../../state/connections';
import { canOpenHere, useSession } from '../../state/session';
import { useSystem, type AppError } from '../../state/system';
import { osText } from '../../lib/osWords';
import { openConnection } from './switcherList';

const useLock = edition.slots.useSwitchLock ?? (() => null);

/** Screens where a test is being recorded or run (or this Mac is the runner): a link doesn't take them away. */
const BUSY = /^\/(apps\/[^/]+\/(tests\/[^/]+\/(record|run)|run-all)|suites\/[^/]+\/run|runner-mode)$/;
/** A link waits this long at most for its workspace to open and its person to sign in. */
const PENDING_MS = 15 * 60_000;

interface Pending { connectionId: string; route: string; at: number }
/** The link waiting for its workspace to be open and signed in. */
export const usePendingLink = create<{ pending: Pending | null }>(() => ({ pending: null }));

const busyProblem = (): AppError => ({ title: 'Finish what’s running first', reason: osText('Breakpatch is recording or running a test here. Finish or stop it, then click the link again.') });

/** Handles one link. `now` is what the screen is now (the path, the switch lock, the router's navigate). */
export async function handleOpenLink(link: string, now: { pathname: string; lock: string | null; navigate: (path: string) => void }): Promise<void> {
  const show = (e: AppError) => useSystem.getState().showError(e);
  const parsed = parseOpenLink(link);
  if (!parsed) { show({ ...BAD_LINK, details: link.trim().slice(0, 300) }); return; }
  if (BUSY.test(now.pathname)) { show(busyProblem()); return; }
  const { list, activeId } = useConnections.getState();
  const r = await resolveOpenLink(parsed, { list, activeId, canOpen: canOpenHere, teamEdition: !!edition.openWorkspace, folderIdOf: p => readFolderId(p) });
  if ('problem' in r) { show(r.problem); return; }
  const c = r.connection;
  if (c.id !== activeId && now.lock) { show({ title: "Couldn't switch workspace", reason: now.lock }); return; }
  usePendingLink.setState({ pending: { connectionId: c.id, route: routeOf(parsed.target), at: Date.now() } });
  if (c.id === activeId) return;
  try { await openConnection(c, now.navigate); }
  catch (e) {
    usePendingLink.setState({ pending: null });
    show({ title: `Couldn't open ${c.name}`, reason: e instanceof Error && e.message ? e.message : 'Try again.' });
  }
}

export function OpenLinks() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const lock = useLock();
  const now = useRef({ pathname, lock, navigate });
  useEffect(() => { now.current = { pathname, lock, navigate }; });

  useEffect(() => {
    let off: (() => void) | undefined;
    let live = true;
    void onWorkspaceLink(payload => { if (isOpenLink(payload)) void handleOpenLink(payload, now.current); })
      .then(f => { if (live) off = f; else f(); });
    return () => { live = false; off?.(); };
  }, []);

  // Open the test once its workspace is the one open, signed in and set up (the gate lets it show).
  const pending = usePendingLink(s => s.pending);
  const activeId = useConnections(s => s.activeId);
  const ready = useSession(s => !!s.backend && !!s.user && s.setupDone);
  useEffect(() => {
    if (!pending) return;
    if (Date.now() - pending.at > PENDING_MS) { usePendingLink.setState({ pending: null }); return; }
    if (pending.connectionId !== activeId || !ready) return;
    usePendingLink.setState({ pending: null });
    navigate(pending.route);
  }, [pending, activeId, ready, navigate]);
  return null;
}

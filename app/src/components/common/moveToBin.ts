// Deleting an app, a test, shared steps or a suite: it goes to Recently deleted for
// KEEP_DELETED_DAYS and can be put back, so there's no "Are you sure?" first. It goes at once, and
// a toast says where, with Undo (⌘Z too) and a way to Recently deleted. Only Delete now there,
// which can't be undone, still asks (DeletedSection).
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../ui';
import { useBackend } from '../../data/hooks';
import type { DeletedRef } from '../../data/backend';

/** Where Settings → Recently deleted is. */
export const RECENTLY_DELETED_PATH = '/settings/deleted';

/** A row of a list (a table row, an app's card) that Delete can take away. */
const ROW = '[role="row"]:not(.app-row-head), .home-card';

/**
 * When focus was in a row that's being deleted: once the row has gone, focus goes to the next row,
 * or the one before, or the list itself, so the keyboard isn't left on nothing.
 */
function keepFocusNear(from: Element | null): () => void {
  const row = from?.closest<HTMLElement>(ROW);
  if (!row) return () => {};
  const list = row.parentElement;
  const sibling = (dir: 'next' | 'prev') => {
    let n = dir === 'next' ? row.nextElementSibling : row.previousElementSibling;
    while (n && !n.matches(ROW)) n = dir === 'next' ? n.nextElementSibling : n.previousElementSibling;
    return n as HTMLElement | null;
  };
  const next = sibling('next'), prev = sibling('prev');
  return () => {
    let tries = 0;
    const settle = () => {
      if (row.isConnected && ++tries < 60) { requestAnimationFrame(settle); return; }   // the list redraws when the data says so
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected && !row.contains(a)) return;        // focus moved on by itself
      const to = [next, prev].find(el => el?.isConnected) ?? (list?.isConnected ? list.closest<HTMLElement>('[role="table"]') ?? list : null);
      if (!to) return;
      if (to === list || to.getAttribute('role') === 'table') { if (!to.hasAttribute('tabindex')) to.tabIndex = -1; }
      to.focus();
    };
    requestAnimationFrame(settle);
  };
}

/**
 * Returns move(ref, name, del, failed): runs del (the backend's deleteTest, deleteApp, …) and says
 * so in a toast with Undo and Show (Recently deleted), or shows the error. `said` replaces the
 * toast's words. Resolves true once it's deleted.
 */
export function useMoveToBin() {
  const backend = useBackend();
  const toast = useToast();
  const navigate = useNavigate();
  return useCallback(async (ref: DeletedRef, name: string, del: () => Promise<void>, failed: string, said?: string): Promise<boolean> => {
    const refocus = keepFocusNear(document.activeElement);
    try { await del(); }
    catch (e) { toast(e instanceof Error ? e.message : failed, { error: true }); return false; }
    refocus();
    const bin = backend.recentlyDeleted;
    const undo = () => {
      bin?.restore(ref).then(
        () => toast(restoredText(name)),
        e => toast(e instanceof Error ? e.message : `Couldn't put "${name}" back. It's in Recently deleted.`, { error: true }),
      );
    };
    toast(said ?? `"${name}" moved to Recently deleted.`, bin ? {
      actions: [{ label: 'Undo', undo: true, onClick: undo }, { label: 'Show', name: 'Show Recently deleted', onClick: () => navigate(RECENTLY_DELETED_PATH) }],
    } : undefined);
    return true;
  }, [backend, toast, navigate]);
}

/** What putting something back says, everywhere: "Log in" is back. Several: "Log in" and "Log out" are back. */
export function restoredText(...names: string[]): string {
  const q = names.map(n => `"${n}"`);
  if (q.length === 1) return `${q[0]} is back.`;
  return `${q.slice(0, -1).join(', ')} and ${q.at(-1)} are back.`;
}

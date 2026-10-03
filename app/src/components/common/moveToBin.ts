// Deleting an app, a test, shared steps or a suite: it goes to Recently deleted for
// KEEP_DELETED_DAYS and can be put back, so there's no "Are you sure?" first. It goes at once, and
// a toast says where, with Undo and a way to Recently deleted. Only Delete now there, which can't
// be undone, still asks (DeletedSection).
import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../ui';
import { useBackend } from '../../data/hooks';
import type { DeletedRef } from '../../data/backend';

/** Where Settings → Recently deleted is. */
export const RECENTLY_DELETED_PATH = '/settings/deleted';

/**
 * Returns move(ref, name, del, failed): runs del (the backend's deleteTest, deleteApp, …) and says
 * so in a toast with Undo and Open Recently deleted, or shows the error. `said` replaces the toast's
 * words. Resolves true once it's deleted.
 */
export function useMoveToBin() {
  const backend = useBackend();
  const toast = useToast();
  const navigate = useNavigate();
  return useCallback(async (ref: DeletedRef, name: string, del: () => Promise<void>, failed: string, said?: string): Promise<boolean> => {
    try { await del(); }
    catch (e) { toast(e instanceof Error ? e.message : failed, { error: true }); return false; }
    const bin = backend.recentlyDeleted;
    const undo = () => {
      bin?.restore(ref).then(
        () => toast(`"${name}" is back.`),
        e => toast(e instanceof Error ? e.message : `Couldn't put "${name}" back. It's in Recently deleted.`, { error: true }),
      );
    };
    toast(said ?? `"${name}" moved to Recently deleted.`, bin ? {
      actions: [{ label: 'Undo', onClick: undo }, { label: 'Open Recently deleted', onClick: () => navigate(RECENTLY_DELETED_PATH) }],
    } : undefined);
    return true;
  }, [backend, toast, navigate]);
}

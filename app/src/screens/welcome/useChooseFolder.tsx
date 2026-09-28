// Picking a tests folder, shared by Welcome and Settings → Tests folder:
// has a breakpatch.json → open it; empty → set it up; other files → ask first.
import { useState } from 'react';
import { Button, Dialog } from '../../components/ui';
import { checkWritable, folderStorage, initFolder, inspectFolder, PREVIEW_FOLDER } from '../../data/local/folder';
import { FolderError } from '../../data/local/localBackend';
import { forgetRecentFolder } from '../../lib/recentFolders';
import { isTauri, pickFolder } from '../../platform';
import { useSession } from '../../state/session';

/** "/Users/ana/Projects/web" → "~/Projects/web" */
export function shortPath(p: string): string { return p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~'); }

export function useChooseFolder(onOpened?: (path: string) => void) {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async (path: string, confirmed = false) => {
    setBusy(true); setError(null);
    try {
      const st = await folderStorage();
      const kind = await inspectFolder(st, path);
      if (kind === 'other' && !confirmed) { setAsking(path); return; }
      await checkWritable(st, path);
      if (kind !== 'breakpatch') await initFolder(st, path);
      await useSession.getState().connectLocal(path);
      onOpened?.(path);
    } catch (e) {
      if (e instanceof FolderError && e.code === 'missing') forgetRecentFolder(path);
      setError(e instanceof FolderError ? e.message : `Couldn't open this folder. ${(e as Error).message ?? ''}`.trim());
    } finally { setBusy(false); }
  };

  /** The system folder picker on the Mac; the in-memory folder in the browser preview. */
  const choose = async () => {
    setError(null);
    const path = isTauri() ? await pickFolder() : PREVIEW_FOLDER;
    if (path) await open(path);
  };

  const dialog = (
    <Dialog open={!!asking} onClose={() => setAsking(null)} title="Use this folder?" icon="create_new_folder" width={460}
      actions={<>
        <Button onClick={() => setAsking(null)}>Cancel</Button>
        <Button kind="primary" onClick={() => { const p = asking!; setAsking(null); void open(p, true); }}>Use this folder</Button>
      </>}>
      <p className="wl-dlg-text">Breakpatch adds a breakpatch.json file and an apps folder.</p>
      {asking && <div className="wl-dlg-path">{shortPath(asking)}</div>}
    </Dialog>
  );

  return { choose, open, busy, error, clearError: () => setError(null), dialog };
}

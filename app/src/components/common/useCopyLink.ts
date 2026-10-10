// "Copy link" on a test's and a suite's menu (lib/openLinks.ts, public roadmap #32): a
// breakpatch://open link that opens it in this workspace or tests folder, on any Mac that has it.
import { useCallback } from 'react';
import { useBackend } from '../../data/hooks';
import { copyableLink, type LinkTarget } from '../../lib/openLinks';
import { copyTextSoon } from '../../platform';
import { useToast } from '../ui';

export function useCopyLink(): (t: LinkTarget, name: string) => Promise<void> {
  const backend = useBackend();
  const toast = useToast();
  return useCallback(async (t: LinkTarget, name: string) => {
    try {
      // Started within the click: the folder's id may need a file written first (copyTextSoon).
      await copyTextSoon(copyableLink(backend, t));
      toast(backend.workspace ? `Link to ${name} copied. It opens for anyone with this workspace on their Mac.` : `Link to ${name} copied. It opens wherever this tests folder is open.`);
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't copy the link.", { error: true });
    }
  }, [backend, toast]);
}

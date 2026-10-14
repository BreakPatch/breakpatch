// How this copy is updated (lib/updates.ts updateSource), for a screen: null until the shell has
// said, then 'self' or 'package' (a Linux .deb, which its package manager updates).
import { useEffect, useState } from 'react';
import { knownUpdateSource, updateSource, type UpdateSource } from './updates';

/** Where a .deb's new version is: the release's assets. */
export const RELEASES_URL = 'https://github.com/BreakPatch/breakpatch/releases';

export function useUpdateSource(): UpdateSource | null {
  const [source, setSource] = useState<UpdateSource | null>(knownUpdateSource);
  useEffect(() => {
    let live = true;
    void updateSource().then(s => { if (live) setSource(s); });
    return () => { live = false; };
  }, []);
  return source;
}

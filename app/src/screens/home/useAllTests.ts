import { useEffect, useState } from 'react';
import { useBackend } from '../../data/hooks';
import type { App, Test } from '../../data/types';

/** Live tests for every app on Home. An app's entry is missing until its first value arrives. */
export function useAllTests(apps: App[] | undefined): Record<string, Test[]> {
  const backend = useBackend();
  const [byApp, setByApp] = useState<Record<string, Test[]>>({});
  const ids = (apps ?? []).map(a => a.id).join('|');
  useEffect(() => {
    if (!ids) { setByApp({}); return; }
    const offs = ids.split('|').map(id => backend.tests(id, list => setByApp(m => ({ ...m, [id]: list }))));
    return () => offs.forEach(off => off());
  }, [backend, ids]);
  return byApp;
}

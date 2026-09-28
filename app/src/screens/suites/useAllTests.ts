// Tests of every app, for the suite editor and the suite run view.
import { useEffect, useState } from 'react';
import type { App, Test } from '../../data/types';
import { useBackend } from '../../data/hooks';

/** Tests of every app, keyed by app id. `undefined` until every app has answered. */
export function useAllTests(apps: App[] | undefined): Record<string, Test[]> | undefined {
  const backend = useBackend();
  const [map, setMap] = useState<Record<string, Test[]>>({});
  const ids = apps?.map(a => a.id).join('|') ?? '';
  useEffect(() => {
    if (!apps) return;
    setMap({});
    const offs = apps.map(a => backend.tests(a.id, list => setMap(m => ({ ...m, [a.id]: list }))));
    return () => offs.forEach(f => f());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, ids]);
  return apps && apps.every(a => map[a.id]) ? map : undefined;
}

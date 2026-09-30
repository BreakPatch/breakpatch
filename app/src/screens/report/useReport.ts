// Loads what the run report shows: the run, its test, the steps as they were in the version
// it tested (shared steps resolved), and the test's other runs for Run history.
import { useEffect, useState } from 'react';
import type { App, Run, Step, Test } from '../../data/types';
import { useBackend, useLive, usePagedLive } from '../../data/hooks';
import { backendGroupLoader, resolveSteps } from '../run/resolve';

export function useReport(appId: string, runId: string) {
  const backend = useBackend();
  const [fetched, setFetched] = useState<Run | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setFetched(undefined);
    backend.run(appId, runId).then(r => { if (live) setFetched(r); }, () => { if (live) setFetched(null); });
    return () => { live = false; };
  }, [backend, appId, runId]);

  const testId = fetched?.testId ?? '';
  const history = usePagedLive<Run>((b, l, limit) => (testId ? b.testRuns(appId, testId, l, limit) : () => {}), [appId, testId]);
  const runs = history.data;
  const test = useLive<Test | null>((b, l) => (testId ? b.test(appId, testId, l) : () => {}), [appId, testId]).data;
  const apps = useLive<App[]>((b, l) => b.apps(l), []).data;
  // The live list's copy (it has what was added to the run later, on any Mac: Backend.runNotes), else the one read by id.
  const run = runs?.find(r => r.id === runId) ?? fetched;

  const [steps, setSteps] = useState<Step[] | null>(null);
  const version = fetched?.testVersion;
  const current = test?.currentVersion;
  useEffect(() => {
    if (!testId || version === undefined || test === undefined) return;
    let live = true;
    (async () => {
      // Without version history only the latest version is kept; then the report shows that one.
      const v = (await backend.version(appId, testId, version)) ?? (current ? await backend.version(appId, testId, current) : null);
      const out = await resolveSteps(v?.steps ?? [], backendGroupLoader(backend, appId)).catch(() => v?.steps ?? []);
      if (live) setSteps(out);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, appId, testId, version, current, test === undefined]);

  return { run, runs, moreRuns: history.hasMore ? history.more : undefined, test, steps, app: apps?.find(a => a.id === appId), missing: fetched === null };
}

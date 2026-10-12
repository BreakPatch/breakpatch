// Starts the automatic update checks (lib/autoUpdates.ts) for the window, and keeps them back while
// a test is recorded or run, so an update doesn't download alongside. Setup holds them itself while
// it downloads (SetupScreen). Shows nothing: an update found shows in SystemBanners.
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { holdUpdateChecks, startAutoUpdates } from '../../lib/autoUpdates';

/** The recorder, the shared steps editor, a run going on (a test, an app's tests, a suite). */
export const BUSY_PATH = /\/(record|run|run-all|edit)$/;

export function AutoUpdates() {
  const busy = BUSY_PATH.test(useLocation().pathname);
  useEffect(() => startAutoUpdates(), []);
  useEffect(() => (busy ? holdUpdateChecks() : undefined), [busy]);
  return null;
}

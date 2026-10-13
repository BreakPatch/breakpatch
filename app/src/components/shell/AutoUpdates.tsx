// Starts the automatic update checks (lib/autoUpdates.ts) for the window. The screens keep them back
// themselves while they're busy (lib/useHoldUpdateChecks.ts: recording, a run, setup's downloads),
// so an update doesn't download alongside. Shows nothing: an update found shows in SystemBanners.
import { useEffect } from 'react';
import { startAutoUpdates } from '../../lib/autoUpdates';

export function AutoUpdates() {
  useEffect(() => startAutoUpdates(), []);
  return null;
}

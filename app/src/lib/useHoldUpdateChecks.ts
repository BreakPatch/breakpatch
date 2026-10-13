// Keeps automatic update checks back (lib/autoUpdates.ts holdUpdateChecks) while a screen is busy
// with something an update downloading alongside could disturb: a step being recorded or the test
// playing in the recorder, a run or a suite going on, setup's downloads. A screen that's open but
// idle (a run that has ended, a recorder nobody is recording in) holds nothing.
import { useEffect } from 'react';
import { holdUpdateChecks } from './autoUpdates';

/** Holds automatic update checks while `active`; released when it isn't, or when the screen closes. */
export function useHoldUpdateChecks(active: boolean): void {
  useEffect(() => (active ? holdUpdateChecks() : undefined), [active]);
}

// Where a save's steps were recorded (engine/PROTOCOL.md "Where a test was recorded"). The engine
// knows this system and its Chromium (system.info `system`); the app writes it into the version.
import type { RecordedOn } from '../../data/types';
import type { Engine } from '../../engine';

/**
 * `recordedOn` for a save: this system when a step was recorded or re-recorded since loading,
 * otherwise what the loaded version had (edits alone don't change where the steps came from).
 * An engine too old to say, or one that can't be reached, leaves it as it was.
 */
export async function recordedOnForSave(engine: Pick<Engine, 'systemInfo'>, recordedHere: boolean, before: RecordedOn | undefined): Promise<RecordedOn | undefined> {
  if (!recordedHere) return before;
  try { return (await engine.systemInfo()).system ?? before; }
  catch { return before; }
}

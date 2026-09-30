// System-wide states shown as banners or blocking screens (design "System states").
import { create } from 'zustand';
import { appVersion } from '../platform';

export interface AppError { title: string; reason: string; details?: string; retry?: () => void }

interface SystemState {
  /** A downloaded update waiting for a restart, e.g. "1.5.0". */
  updateReady: string | null;
  updateDismissed: boolean;
  /**
   * Saving is off: the backend found data saved by a newer app (the Team workspace's
   * schemaVersion is higher than this app's). Reading and running still work.
   */
  readOnly: boolean;
  error: AppError | null;
  /**
   * The engine has answered once since the app opened. Until then the app says it's starting: the
   * packaged engine unpacks itself first, which takes a while on a Mac's first start.
   */
  engineReady: boolean;
  /**
   * No engine of this app version has answered on this Mac before: the first start, which takes
   * longer (a new engine is unpacked and macOS checks it). Worked out once, at launch.
   */
  firstEngineStart: boolean;
  markEngineReady(): void;
  /** Plain lines about data the backend skipped (a tests-folder file that isn't valid JSON). */
  warnings: string[];
  warningsDismissed: boolean;
  setWarnings(v: string[]): void;
  dismissWarnings(): void;
  setUpdateReady(v: string | null): void;
  dismissUpdate(): void;
  setReadOnly(v: boolean): void;
  showError(e: AppError | null): void;
}

/** The app version whose engine last answered on this Mac. */
export const ENGINE_STARTED_KEY = 'breakpatch.engineStarted.v1';
function startedBefore(): boolean {
  try { return localStorage.getItem(ENGINE_STARTED_KEY) === appVersion(); } catch { return false; }
}
function noteStarted() {
  try { localStorage.setItem(ENGINE_STARTED_KEY, appVersion()); } catch { /* next start says "first" again */ }
}

export const useSystem = create<SystemState>(set => ({
  updateReady: null,
  updateDismissed: false,
  readOnly: false,
  error: null,
  engineReady: false,
  firstEngineStart: !startedBefore(),
  markEngineReady: () => set(s => { if (s.engineReady) return s; noteStarted(); return { engineReady: true }; }),
  warnings: [],
  warningsDismissed: false,
  setWarnings: warnings => set(s => ({ warnings, warningsDismissed: s.warningsDismissed && warnings.join('\n') === s.warnings.join('\n') })),
  dismissWarnings: () => set({ warningsDismissed: true }),
  setUpdateReady: updateReady => set({ updateReady, updateDismissed: false }),
  dismissUpdate: () => set({ updateDismissed: true }),
  setReadOnly: readOnly => set({ readOnly }),
  showError: error => set({ error }),
}));

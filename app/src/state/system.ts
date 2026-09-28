// System-wide states shown as banners or blocking screens (design "System states").
import { create } from 'zustand';

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

export const useSystem = create<SystemState>(set => ({
  updateReady: null,
  updateDismissed: false,
  readOnly: false,
  error: null,
  warnings: [],
  warningsDismissed: false,
  setWarnings: warnings => set(s => ({ warnings, warningsDismissed: s.warningsDismissed && warnings.join('\n') === s.warnings.join('\n') })),
  dismissWarnings: () => set({ warningsDismissed: true }),
  setUpdateReady: updateReady => set({ updateReady, updateDismissed: false }),
  dismissUpdate: () => set({ updateDismissed: true }),
  setReadOnly: readOnly => set({ readOnly }),
  showError: error => set({ error }),
}));

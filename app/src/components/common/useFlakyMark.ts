// Answering a test's Flaky marker (lib/flaky.ts): known flaky, not flaky, or taking it back.
// Shared by the Tests tab and the report. Only where the backend can keep it (Backend.setFlakyMark).
import { useCallback } from 'react';
import { useBackend } from '../../data/hooks';
import type { FlakyMark, Test } from '../../data/types';
import { useSession } from '../../state/session';
import { useToast } from '../ui';

export type FlakyAnswer = FlakyMark['state'] | null;

const SAID: Record<'known' | 'not' | 'clear', string> = {
  known: 'Marked as known flaky.',
  not: "Marked as not flaky. Its runs so far no longer count; a new failure between passes shows it again.",
  clear: 'No longer marked as known flaky.',
};

/** null when this workspace or folder can't keep the answer. */
export function useFlakyMark(): ((test: Pick<Test, 'appId' | 'id' | 'currentVersion'>, answer: FlakyAnswer) => Promise<void>) | null {
  const backend = useBackend();
  const toast = useToast();
  const set = useCallback(async (test: Pick<Test, 'appId' | 'id' | 'currentVersion'>, answer: FlakyAnswer) => {
    const user = useSession.getState().user ?? backend.currentUser();
    const mark: FlakyMark | null = answer ? { state: answer, version: test.currentVersion, by: user?.name ?? '', at: Date.now() } : null;
    try {
      await backend.setFlakyMark!(test.appId, test.id, mark);
      toast(SAID[answer ?? 'clear']);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save that.", { error: true });
    }
  }, [backend, toast]);
  return backend.setFlakyMark ? set : null;
}

/** The menu items for a test's marker: what can be said now. */
export function flakyMenuItems(known: boolean, onAnswer: (a: FlakyAnswer) => void) {
  return known
    ? [{ label: 'Not known flaky any more', icon: 'swap_vert', onSelect: () => onAnswer(null) }]
    : [
        { label: 'Mark as known flaky', icon: 'swap_vert', onSelect: () => onAnswer('known') },
        { label: "It's not flaky", icon: 'check_circle', onSelect: () => onAnswer('not') },
      ];
}

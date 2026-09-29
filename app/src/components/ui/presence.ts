// Keep a closing panel on screen long enough to animate out.
import { useEffect, useState } from 'react';

/** How long a panel takes to leave (matches `.closing` in global.css). */
export const EXIT_MS = 140;

/**
 * `mounted` stays true for `ms` after `open` turns false, with `closing` set meanwhile so CSS can
 * play the way out. Reopening while it's leaving just clears `closing`, and the CSS transition
 * turns back from wherever it had got to.
 */
export function usePresence(open: boolean, ms = EXIT_MS) {
  const [shown, setShown] = useState(open);
  const [prev, setPrev] = useState(open);
  if (open !== prev) { setPrev(open); if (open) setShown(true); }
  useEffect(() => {
    if (open || !shown) return;
    const t = setTimeout(() => setShown(false), ms);
    return () => clearTimeout(t);
  }, [open, shown, ms]);
  return { mounted: open || shown, closing: !open && shown };
}

/**
 * The last value that wasn't null, so a panel built from state can still draw while it leaves.
 * Pass `same` when the value is a fresh object on every render (it's kept only when it differs).
 */
export function useLatched<T>(value: T | null | undefined, same: (a: T, b: T) => boolean = Object.is): T | null {
  const [last, setLast] = useState<T | null>(value ?? null);
  if (value != null && (last == null || !same(value, last))) setLast(value);
  return value ?? last;
}

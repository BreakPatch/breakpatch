// How often a suite's failed test is tried again (roadmap #14, engine/PROTOCOL.md "Retries"): only
// when its failure looks like timing, from the start in a new browser, and always said in the run,
// the report and the suite's result. The engine decides which failures; the suite says how many.
import type { Suite } from '../data/types';

/** The most retries a suite may ask for (the engine's retry.MAX_RETRIES). */
export const MAX_RETRIES = 2;
/** A suite that doesn't say: retried once, on this Mac and on the local runner. breakpatch-ci only retries with --retries. */
export const DEFAULT_RETRIES = 1;

/** A stored suite's `retries` (a suite file's, a workspace's): 0 to MAX_RETRIES, else none (the default). */
export function retriesIn(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_RETRIES ? v : undefined;
}

/** A suite's retries, 0 to MAX_RETRIES: its own, or DEFAULT_RETRIES when it has none (or a value that isn't one). */
export function retriesOf(suite: Pick<Suite, 'retries'> | null | undefined): number {
  return retriesIn(suite?.retries) ?? DEFAULT_RETRIES;
}

/** The suite editor's choices. */
export const RETRY_CHOICES: { value: number; label: string }[] = [
  { value: 0, label: "Don't retry" },
  { value: 1, label: 'Retry once' },
  { value: 2, label: 'Retry twice' },
];

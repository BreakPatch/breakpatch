// "Why did this fail?" (roadmap #7, Breakpatch Team): the AI assistant's plain explanation of a
// failed step, asked of the engine (`run.explain`) on demand, never during a run. Kept on the saved
// run's StepRun (`explanation`) where the backend can, and in memory here, so it's asked once.
// The report shows it; result messages and new issues can take the same data (`explanationText`).
import type { Explanation, FailReason, Run, Step, StepRun, Viewport } from '../data/types';
import type { Backend } from '../data/backend';
import { EngineError, type Engine } from '../engine/engine';

/** The reasons the AI assistant can add to (the engine's explain.EXPLAINED). */
export const EXPLAINED: readonly FailReason[] = ['targetNotFound', 'healFailed', 'noChange', 'unexpectedScreen', 'timeout'];

export const CAUSE_TEXT: Record<Explanation['cause'], string> = {
  moved: 'It moved',
  textChanged: 'Its text changed',
  pageChanged: 'The page changed',
  slowLoad: 'The page was slow to load',
  errorPage: 'The page shows an error',
  realBug: 'Looks like a real bug',
};

export const SUGGESTION_TEXT: Record<Explanation['suggestion'], string> = {
  rerecord: 'Re-record this step.',
  acceptChange: 'If this change is expected, re-record this step to accept it.',
  raiseWait: 'Give the page longer: add a wait before this step.',
  reportBug: 'Report it as a bug. Copy has what the developers need.',
};

/** Whether "Why did this fail?" can be asked for this step's result. `demo`: no screenshot needed. */
export function canExplain(r: StepRun | undefined, demo = false): boolean {
  return !!r && r.result === 'failed' && EXPLAINED.includes(r.reason as FailReason) && (demo || !!r.screenshotPath);
}

const known = <T extends string>(v: string, words: Record<T, string>): string | undefined => (words as Record<string, string>)[v];

/** The plain words for a cause and a suggestion; undefined for a value this app doesn't know. */
export const causeText = (e: Explanation) => known(e.cause, CAUSE_TEXT);
export const suggestionText = (e: Explanation) => known(e.suggestion, SUGGESTION_TEXT);

/** One block of plain text, marked as the AI assistant's: for Copy details, result messages, issues. */
export function explanationText(e: Explanation): string {
  const cause = causeText(e), next = suggestionText(e);
  return [`AI assistant: ${e.summary}`, cause && `Likely cause: ${cause}.`, next && `Suggested: ${next}`].filter(Boolean).join('\n');
}

/**
 * Explanations asked in this session, per backend (so per workspace or folder: two workspaces'
 * runs never share one, and a closed connection's go with it), at most MAX_KEPT each, oldest out first.
 */
export const MAX_KEPT = 200;
const caches = new WeakMap<object, Map<string, Explanation>>();
const noBackend = {};
const cacheOf = (b: Backend | null | undefined) => {
  const k = b ?? noBackend;
  let c = caches.get(k);
  if (!c) { c = new Map(); caches.set(k, c); }
  return c;
};
function keep(c: Map<string, Explanation>, key: string, e: Explanation) {
  c.delete(key); c.set(key, e);
  while (c.size > MAX_KEPT) c.delete(c.keys().next().value!);
}
const pending = new Map<string, Promise<Explanation | null>>();

/** For tests only. */
export function clearExplanationsForTests(): void { caches.delete(noBackend); pending.clear(); }

/**
 * The explanation of a failed step: the one saved on the run, else the one asked earlier, else a
 * new one from the engine (then kept on the run where the backend can). null when the AI
 * assistant couldn't tell. Throws EngineError as the engine does (not_ready, not_found, busy).
 */
export async function explainStep(o: { engine: Engine; backend?: Backend | null; run: Pick<Run, 'id' | 'appId'>; step: Step; stepRun: StepRun; viewport: Pick<Viewport, 'width' | 'height'> }): Promise<Explanation | null> {
  if (o.stepRun.explanation) return o.stepRun.explanation;
  const key = `${o.run.appId}/${o.run.id}/${o.stepRun.stepId}`;
  const cache = cacheOf(o.backend);
  const had = cache.get(key);
  if (had) return had;
  const pendingKey = `${o.backend?.workspace?.config.projectId ?? o.backend?.kind ?? ''}|${key}`;
  let p = pending.get(pendingKey);
  if (!p) {
    p = o.engine.explain(o.step, o.stepRun, o.viewport).then(e => {
      if (e) {
        keep(cache, key, e);
        o.backend?.runNotes?.saveExplanation(o.run.appId, o.run.id, o.stepRun.stepId, e).catch(() => undefined);
      }
      return e;
    }).finally(() => pending.delete(pendingKey));
    pending.set(pendingKey, p);
  }
  return p;
}

/** What the report says when it couldn't ask. */
export function explainProblem(e: unknown): string {
  const code = e instanceof EngineError ? e.code : '';
  if (code === 'busy') return 'A test is running. Ask again when it has finished.';
  if (code === 'not_found') return "The screenshot of this failure isn't on this Mac, so the AI assistant can't look at it here.";
  if (code === 'not_ready' && e instanceof EngineError) return e.message;
  return "The AI assistant couldn't look at this failure. Try again.";
}

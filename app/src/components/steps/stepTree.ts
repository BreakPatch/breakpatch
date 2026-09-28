// Pure helpers for the nested step list. Loops are stored nested (`loop` step with
// `steps`, see engine/PROTOCOL.md); the UI shows them flat with indentation. Moving a
// row works on a flat token list (loop start, children, loop end) so a step naturally
// enters or leaves a loop when it moves past the loop's edge.
import type { Step } from '../../data/types';

export type Token =
  | { kind: 'step'; step: Step }
  | { kind: 'start'; loop: Step }
  | { kind: 'end'; loopId: string };

const isLoop = (s: Step) => s.action === 'loop';

export function toTokens(steps: Step[]): Token[] {
  const out: Token[] = [];
  for (const s of steps) {
    if (isLoop(s)) {
      out.push({ kind: 'start', loop: s });
      out.push(...toTokens(s.steps ?? []));
      out.push({ kind: 'end', loopId: s.id });
    } else out.push({ kind: 'step', step: s });
  }
  return out;
}

/** Rebuilds the nested list. An unmatched end is dropped; an unclosed loop closes at the end. */
export function fromTokens(tokens: Token[]): Step[] {
  const root: Step[] = [];
  const stack: { loop: Step; children: Step[] }[] = [];
  const cur = () => (stack.length ? stack[stack.length - 1].children : root);
  for (const t of tokens) {
    if (t.kind === 'step') cur().push(t.step);
    else if (t.kind === 'start') stack.push({ loop: t.loop, children: [] });
    else {
      const i = stack.findIndex(f => f.loop.id === t.loopId);
      if (i < 0) continue;
      while (stack.length > i) {
        const f = stack.pop()!;
        cur().push({ ...f.loop, steps: f.children });
      }
    }
  }
  while (stack.length) { const f = stack.pop()!; cur().push({ ...f.loop, steps: f.children }); }
  return root;
}

export interface RowInfo {
  step: Step;
  /** 1-based position in the list as shown (loop rows count, shared-step children don't). */
  number: number;
  /** 0 at the top level, 1 inside a loop, and so on. */
  depth: number;
  /** Innermost loop this row sits in. */
  loopId?: string;
  /** Loop rows: numbers of the first and last child ("Steps 3 to 6"). */
  range?: [number, number];
}

export function flatRows(steps: Step[]): RowInfo[] {
  const rows: RowInfo[] = [];
  const walk = (list: Step[], depth: number, loopId?: string) => {
    for (const s of list) {
      const row: RowInfo = { step: s, number: rows.length + 1, depth, loopId };
      rows.push(row);
      if (isLoop(s)) {
        const first = rows.length + 1;
        walk(s.steps ?? [], depth + 1, s.id);
        if (rows.length >= first) row.range = [first, rows.length];
      }
    }
  };
  walk(steps, 0);
  return rows;
}

export const countRows = (steps: Step[]) => flatRows(steps).length;

export function findStep(steps: Step[], id: string): Step | undefined {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner = s.steps && isLoop(s) ? findStep(s.steps, id) : undefined;
    if (inner) return inner;
  }
  return undefined;
}

/** Row number (1-based) of a step as shown, or 0. */
export const numberOf = (steps: Step[], id: string) => flatRows(steps).find(r => r.step.id === id)?.number ?? 0;

/** The steps that run before `id` (loop children included once, in order). */
export function stepsBefore(steps: Step[], id: string): Step[] {
  const out: Step[] = [];
  for (const t of toTokens(steps)) {
    if (t.kind === 'step' && t.step.id === id) break;
    if (t.kind === 'start' && t.loop.id === id) break;
    if (t.kind === 'step') out.push(t.step);
  }
  return out;
}

function mapTree(steps: Step[], fn: (s: Step) => Step | Step[] | null): Step[] {
  const out: Step[] = [];
  for (const s of steps) {
    const next = fn(s);
    if (next === null) continue;
    for (const n of Array.isArray(next) ? next : [next]) {
      out.push(isLoop(n) && n.steps && n === s ? { ...n, steps: mapTree(n.steps, fn) } : n);
    }
  }
  return out;
}

export function updateStep(steps: Step[], id: string, patch: Partial<Step> | ((s: Step) => Step)): Step[] {
  return mapTree(steps, s => s.id !== id ? s : typeof patch === 'function' ? patch(s) : { ...s, ...patch });
}

/** Deleting a loop keeps its steps in place (only the repeat goes). */
export function removeStep(steps: Step[], id: string): Step[] {
  return mapTree(steps, s => s.id !== id ? s : isLoop(s) ? (s.steps ?? []) : null);
}

/** Re-record: the new recording takes the old step's place and id, marked until saved. */
export function replaceStep(steps: Step[], id: string, next: Step): Step[] {
  return mapTree(steps, s => s.id !== id ? s : { ...next, id, rerecorded: true, ...(isLoop(s) ? { steps: s.steps } : {}) });
}

/** Adds a step at the end, or at the end of the open loop. */
export function appendStep(steps: Step[], step: Step, loopId?: string | null): Step[] {
  if (loopId && findStep(steps, loopId)) return updateStep(steps, loopId, l => ({ ...l, steps: [...(l.steps ?? []), step] }));
  return [...steps, step];
}

export function insertAfter(steps: Step[], afterId: string, step: Step): Step[] {
  return mapTree(steps, s => s.id === afterId ? [s, step] : s);
}

/** Deep copy with fresh ids (loop children too). */
export function cloneWithIds(step: Step, makeId: () => string): Step {
  return { ...step, id: makeId(), rerecorded: undefined, steps: step.steps && isLoop(step) ? step.steps.map(c => cloneWithIds(c, makeId)) : step.steps };
}

export function duplicateStep(steps: Step[], id: string, makeId: () => string): { steps: Step[]; copyId: string | null } {
  const src = findStep(steps, id);
  if (!src) return { steps, copyId: null };
  const copy = cloneWithIds(src, makeId);
  return { steps: insertAfter(steps, id, copy), copyId: copy.id };
}

/** [first, last] token indexes of a step, or of a loop's whole block. */
function blockOf(tokens: Token[], id: string): [number, number] | null {
  const i = tokens.findIndex(t => (t.kind === 'step' && t.step.id === id) || (t.kind === 'start' && t.loop.id === id));
  if (i < 0) return null;
  if (tokens[i].kind === 'step') return [i, i];
  const j = tokens.findIndex((t, k) => k > i && t.kind === 'end' && t.loopId === id);
  return [i, j < 0 ? tokens.length - 1 : j];
}

/** Keyboard move: one position up or down. Crossing a loop's edge moves in or out of it. */
export function moveBy(steps: Step[], id: string, delta: -1 | 1): Step[] {
  const tokens = toTokens(steps);
  const b = blockOf(tokens, id);
  if (!b) return steps;
  const [i, j] = b;
  const block = tokens.slice(i, j + 1);
  if (delta < 0) {
    if (i === 0) return steps;
    const next = [...tokens.slice(0, i - 1), ...block, tokens[i - 1], ...tokens.slice(j + 1)];
    return fromTokens(next);
  }
  if (j === tokens.length - 1) return steps;
  const next = [...tokens.slice(0, i), tokens[j + 1], ...block, ...tokens.slice(j + 2)];
  return fromTokens(next);
}

/** Drag and drop: puts the step (or loop block) right before `beforeId`, or at the very end. */
export function moveBefore(steps: Step[], id: string, beforeId: string | null): Step[] {
  if (id === beforeId) return steps;
  const tokens = toTokens(steps);
  const b = blockOf(tokens, id);
  if (!b) return steps;
  const [i, j] = b;
  const block = tokens.slice(i, j + 1);
  const rest = [...tokens.slice(0, i), ...tokens.slice(j + 1)];
  let at = rest.length;
  if (beforeId !== null) {
    at = rest.findIndex(t => (t.kind === 'step' && t.step.id === beforeId) || (t.kind === 'start' && t.loop.id === beforeId));
    if (at < 0) return steps;            // target is inside the moved block
  }
  // Dropping at the very end lands outside any loop.
  return fromTokens([...rest.slice(0, at), ...block, ...rest.slice(at)]);
}

/** Drag and drop: puts the step right after `afterId`. After a loop row means first inside it. */
export function moveAfter(steps: Step[], id: string, afterId: string): Step[] {
  if (id === afterId) return steps;
  const tokens = toTokens(steps);
  const b = blockOf(tokens, id);
  if (!b) return steps;
  const [i, j] = b;
  const block = tokens.slice(i, j + 1);
  const rest = [...tokens.slice(0, i), ...tokens.slice(j + 1)];
  const at = rest.findIndex(t => (t.kind === 'step' && t.step.id === afterId) || (t.kind === 'start' && t.loop.id === afterId));
  if (at < 0) return steps;
  return fromTokens([...rest.slice(0, at + 1), ...block, ...rest.slice(at + 1)]);
}

/** Removes UI-only markers before saving. */
export function stripUi(steps: Step[]): Step[] {
  return steps.map(s => {
    const { rerecorded: _r, ...rest } = s;
    return isLoop(s) && s.steps ? { ...rest, steps: stripUi(s.steps) } : rest;
  });
}

export function hasRerecorded(steps: Step[]): boolean {
  return steps.some(s => s.rerecorded || (isLoop(s) && !!s.steps && hasRerecorded(s.steps)));
}

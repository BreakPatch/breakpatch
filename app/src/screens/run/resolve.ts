// Before a run, shared-steps cards get their child steps from the pinned (or latest) version,
// nested as engine/PROTOCOL.md expects. Loops keep their stored children (resolved too).
// Also: the pre-order walk the engine's `index` counts in, and which row shows each step.
import type { Backend, Listener, Unsubscribe } from '../../data/backend';
import type { HttpCall, Step, StepGroup } from '../../data/types';
import { flatRows } from '../../components/steps';

/** The steps of a shared-steps version, or null when it can't be found. */
export type GroupLoader = (groupId: string, version: number | 'latest') => Promise<Step[] | null>;

const MAX_DEPTH = 5;

export class MissingGroupError extends Error {
  constructor(label: string) { super(`The shared steps "${label}" can't be found. Open the test and pick them again.`); }
}

export async function resolveSteps(steps: Step[], load: GroupLoader, depth = 0): Promise<Step[]> {
  if (depth > MAX_DEPTH) throw new Error('Shared steps are nested too deep.');
  const out: Step[] = [];
  for (const s of steps) {
    if (s.action === 'group' && s.groupId) {
      const children = await load(s.groupId, s.groupVersion ?? 'latest');
      if (!children) throw new MissingGroupError(s.label);
      out.push({ ...s, steps: await resolveSteps(children, load, depth + 1) });
    } else if (s.action === 'loop') {
      out.push({ ...s, steps: await resolveSteps(s.steps ?? [], load, depth + 1) });
    } else out.push(s);
  }
  return out;
}

/** First value of a live subscription. */
export function once<T>(sub: (l: Listener<T>) => Unsubscribe): Promise<T> {
  return new Promise(resolve => {
    let done = false;
    let off: Unsubscribe | undefined;
    off = sub(v => {
      if (done) return;
      done = true; resolve(v);
      queueMicrotask(() => off?.());
    });
    if (done) off();
  });
}

/** Loads shared steps through the backend ("latest" = the group's current version). */
export function backendGroupLoader(backend: Backend, appId: string): GroupLoader {
  let groups: Promise<StepGroup[]> | undefined;
  return async (groupId, version) => {
    let n = version;
    if (n === 'latest') {
      groups ??= once<StepGroup[]>(l => backend.stepGroups(appId, l));
      n = (await groups).find(g => g.id === groupId)?.currentVersion ?? 0;
    }
    if (!n) return null;
    return (await backend.groupVersion(appId, groupId, n))?.steps ?? null;
  };
}

const container = (s: Step) => (s.action === 'loop' || s.action === 'group') && !!s.steps;

/** Every step in run order: a loop or group, then its children (engine/PROTOCOL.md `index`). */
export function preorder(steps: Step[]): Step[] {
  const out: Step[] = [];
  const walk = (list: Step[]) => list.forEach(s => { out.push(s); if (container(s)) walk(s.steps!); });
  walk(steps);
  return out;
}

/** Names of the saved secrets the steps use (a Write step's, a Call step's headers'), so only those are read from the Keychain. */
export function secretNames(steps: Step[]): string[] {
  return [...new Set(preorder(steps).flatMap(s => [s.secretRef, ...(s.action === 'call' ? callSecretNames(s.call) : [])]).filter((n): n is string => !!n))];
}

/** Names of the saved secrets the set-up and clean-up calls' headers use. */
export function callSecretNames(...calls: (HttpCall | undefined)[]): string[] {
  return [...new Set(calls.flatMap(c => c?.headers ?? []).map(h => h.secretRef).filter((n): n is string => !!n))];
}

export interface RowRef {
  /** The row that shows this step: itself, or the shared-steps card it sits in. */
  rowId: string;
  /** "6", or "2.3" for the third step inside the shared-steps card on row 2. */
  number: string;
}

/**
 * Where each step appears in the steps list. Loop children are rows of their own; the steps
 * inside a shared-steps card aren't, so they point at the card (numbered "2.3" like the card's list).
 */
export function rowRefs(steps: Step[]): Map<string, RowRef> {
  const map = new Map<string, RowRef>();
  for (const r of flatRows(steps)) {
    map.set(r.step.id, { rowId: r.step.id, number: String(r.number) });
    if (r.step.action === 'group') {
      const inner = (list: Step[], prefix: string) => list.forEach((c, i) => {
        const number = `${prefix}.${i + 1}`;
        if (!map.has(c.id)) map.set(c.id, { rowId: r.step.id, number });
        if (container(c)) inner(c.steps!, number);
      });
      inner(r.step.steps ?? [], String(r.number));
    }
  }
  return map;
}

/** The rows of the steps list, in order (loop rows included). */
export const rowIds = (steps: Step[]) => flatRows(steps).map(r => r.step.id);

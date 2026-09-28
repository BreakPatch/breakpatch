// The built-in sample app shown in the live view in demo mode (design/Sample App.dc.html).
// Pure model: where its targets are, and how recorded steps change what it shows.
import type { Box, Point, Step, Viewport } from '../../../data/types';

export interface SampleState {
  dialog: boolean;               // Create project dialog open
  name: string;                  // what's typed in Project name
  focus: 'name' | null;
  created: string | null;        // success message for the last created project
  projects: string[];            // projects added during this session (newest first)
}

export const SAMPLE_INITIAL: SampleState = { dialog: false, name: '', focus: null, created: null, projects: [] };
export const SAMPLE_PATH = '/projects';

export type SampleKey = 'new' | 'name' | 'done' | 'cancel' | 'success';

export interface SampleTargetDef {
  key: SampleKey;
  /** left, top, width, height as fractions of the viewport (same numbers as the design's hotspots). */
  rect: [number, number, number, number];
  words: string[];
  target: string;
  label: string;
  visible: (s: SampleState) => boolean;
}

export const SAMPLE_TARGETS: SampleTargetDef[] = [
  { key: 'new', rect: [0.88, 0.106, 0.096, 0.052], words: ['new project', 'new'], target: 'New project button, top right', label: 'Click New project', visible: s => !s.dialog },
  { key: 'name', rect: [0.325, 0.306, 0.35, 0.056], words: ['project name', 'name field', 'name'], target: 'Project name field in the Create project dialog', label: 'Click Project name', visible: s => s.dialog },
  { key: 'done', rect: [0.606, 0.678, 0.066, 0.052], words: ['done'], target: 'Done button, bottom right of the Create project dialog', label: 'Click Done', visible: s => s.dialog },
  { key: 'cancel', rect: [0.53, 0.678, 0.07, 0.052], words: ['cancel'], target: 'Cancel button in the Create project dialog', label: 'Click Cancel', visible: s => s.dialog },
  { key: 'success', rect: [0.389, 0.027, 0.222, 0.053], words: ['success', 'message', 'created'], target: 'Green message at the top', label: 'Click the success message', visible: s => !s.dialog && !!s.created },
];

export function boxOf(def: SampleTargetDef, vp: Pick<Viewport, 'width' | 'height'>): Box {
  const [l, t, w, h] = def.rect;
  return [Math.round(l * vp.width), Math.round(t * vp.height), Math.round((l + w) * vp.width), Math.round((t + h) * vp.height)];
}

const inside = (p: Point, b: Box) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** The target under a point. `onlyVisible: false` also finds targets that are hidden right now. */
export function hitSample(p: Point, vp: Pick<Viewport, 'width' | 'height'>, s: SampleState, onlyVisible = true): SampleTargetDef | undefined {
  return SAMPLE_TARGETS.find(d => (!onlyVisible || d.visible(s)) && inside(p, boxOf(d, vp)));
}

function hhmm(d: Date) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

/** What the sample app would show for written text (`{i}`, `{time}`, `{date}` filled in). */
export function expandText(text: string, repeat = 1, now = new Date()): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return text.replace(/\{i\}/g, String(repeat)).replace(/\{time\}/g, hhmm(now)).replace(/\{date\}/g, date);
}

const POINT_ACTIONS = new Set<Step['action']>(['click', 'doubleClick', 'longClick', 'rightClick']);

/** Applies one step to the sample app. */
export function applyStep(s: SampleState, step: Step, vp: Pick<Viewport, 'width' | 'height'>, repeat = 1, now = new Date()): SampleState {
  if (step.action === 'loop') {
    let out = s;
    for (let i = 1; i <= Math.max(1, step.count ?? 1); i++) for (const c of step.steps ?? []) out = applyStep(out, c, vp, i, now);
    return out;
  }
  if (step.action === 'group') {
    let out = s;
    for (const c of step.steps ?? []) out = applyStep(out, c, vp, repeat, now);
    return out;
  }
  if (step.action === 'navigate') return step.nav === 'back' || step.nav === 'forward' ? { ...s, dialog: false, focus: null } : { ...SAMPLE_INITIAL, projects: s.projects };
  if (step.action === 'write') {
    if (s.focus !== 'name') return s;
    const value = step.secretRef ? '••••••••' : step.generated
      ? { uniqueName: 'Project ' + now.getTime().toString(36).slice(-4), timeNow: hhmm(now), today: expandText('{date}', 1, now), repeatNumber: String(repeat) }[step.generated]
      : expandText(step.text ?? '', repeat, now);
    return { ...s, name: s.name + value };
  }
  if (!POINT_ACTIONS.has(step.action) || !step.at) return s;
  const hit = hitSample(step.at, vp, s);
  switch (hit?.key) {
    case 'new': return { ...s, dialog: true, name: '', focus: null, created: null };
    case 'name': return { ...s, focus: 'name' };
    case 'done': {
      const name = s.name.trim() || 'Untitled project';
      return { ...s, dialog: false, focus: null, created: name, projects: [name, ...s.projects] };
    }
    case 'cancel': return { ...s, dialog: false, focus: null };
    case 'success': return s;
    default: return s.dialog ? s : { ...s, focus: null };
  }
}

export function replay(steps: Step[], vp: Pick<Viewport, 'width' | 'height'>, from: SampleState = SAMPLE_INITIAL): SampleState {
  return steps.reduce((acc, st) => applyStep(acc, st, vp), from);
}

// The action list (ui-requirements §5.6) and what each action does with the page and the composer.
import type { ActionKind } from '../../data/types';
import { ACTIONS, actionInfo } from '../../engine/labels';
import type { LiveTool } from '../../components/live';

/** Menu entries. Reload, Back and Forward are Go-to-address variants that record at once. */
export interface MenuAction { id: string; kind: ActionKind; name: string; icon: string; nav?: 'reload' | 'back' | 'forward' }
export interface MenuGroup { title: string; items: MenuAction[] }

const item = (kind: ActionKind): MenuAction => { const a = actionInfo(kind); return { id: kind, kind, name: a.name, icon: a.icon }; };

export function menuGroups(opts: { allowGroups: boolean }): MenuGroup[] {
  const by = (g: string) => ACTIONS.filter(a => a.group === g).map(a => item(a.kind));
  return [
    { title: 'Gestures', items: by('Gestures') },
    { title: 'Input', items: by('Input') },
    { title: 'Waiting', items: by('Waiting') },
    { title: 'Browser', items: [
      item('navigate'),
      { id: 'reload', kind: 'navigate', name: 'Reload', icon: 'refresh', nav: 'reload' },
      { id: 'back', kind: 'navigate', name: 'Back', icon: 'arrow_back', nav: 'back' },
      { id: 'forward', kind: 'navigate', name: 'Forward', icon: 'arrow_forward', nav: 'forward' },
      item('switchTab'), item('upload'), item('downloadCheck'),
    ] },
    { title: 'Checkpoint', items: [item('checkpoint')] },
    { title: 'Structure', items: opts.allowGroups ? by('Structure') : [item('loop')] },
  ];
}

/** Short name on the composer's action button. */
export const SHORT: Partial<Record<ActionKind, string>> = {
  checkpoint: 'Checkpoint', loop: 'Repeat', group: 'Shared steps', waitUntil: 'Wait until', waitFor: 'Wait',
  navigate: 'Go to address', downloadCheck: 'Check download', upload: 'Upload file', drag: 'Drag and drop',
};
export const shortName = (k: ActionKind) => SHORT[k] ?? actionInfo(k).name;

/** Actions whose target on the page can be clicked or described. */
export const POINT_KINDS = new Set<ActionKind>(['click', 'doubleClick', 'longClick', 'rightClick', 'hover', 'upload', 'swipe', 'scroll']);

/** What pressing on the page does for the chosen action. */
export function toolFor(k: ActionKind): LiveTool {
  if (k === 'drag' || k === 'swipe' || k === 'scroll') return 'drag';
  if (k === 'checkpoint' || k === 'waitUntil') return 'box';
  return 'point';
}

/** These stay chosen after a step is added; everything else goes back to Click. */
export const STICKY = new Set<ActionKind>(['click', 'doubleClick', 'longClick', 'rightClick', 'hover', 'swipe', 'scroll', 'drag']);

/** Picking these adds the step right away. */
export const INSTANT = new Set<string>(['reload', 'back', 'forward', 'switchTab']);

export type ComposerInput = 'describe' | 'text' | 'url' | 'none';
export function composerInput(k: ActionKind): ComposerInput {
  if (POINT_KINDS.has(k) || k === 'checkpoint' || k === 'waitUntil') return 'describe';
  if (k === 'write') return 'text';
  if (k === 'navigate') return 'url';
  return 'none';
}

export function placeholderFor(k: ActionKind): string {
  switch (k) {
    case 'write': return 'Type the text to write, for example: Test project {time}';
    case 'checkpoint': return 'Name the checkpoint, or click the area on the page';
    case 'waitUntil': return 'Describe what should appear, or draw a box around it on the page';
    case 'navigate': return 'Type the address, for example: https://app.example.com/projects';
    case 'swipe': case 'scroll': return 'Describe the step or where to start, or drag on the page';
    default: return 'Describe the next step, for example: click the Done button';
  }
}

/** Hint row text for tools that need more than a click. */
export function toolHint(k: ActionKind): string | null {
  switch (k) {
    case 'drag': return 'Drag on the page from the start point to the end point, or click one and then the other.';
    case 'swipe': case 'scroll': return 'Drag on the page in the direction to move. The length of the drag sets the distance.';
    case 'checkpoint': return 'Click or draw a box around what should be visible, or name it below.';
    case 'waitUntil': return 'Draw a box around what should appear, or describe it below.';
    default: return null;
  }
}

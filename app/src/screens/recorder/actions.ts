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
// ============================== DESCRIBE SWITCH ==============================
// The add-step bar's "Describe the next step" box. Off from 2026-10-02 for the launch; back on
// with #10, which goes through a story's steps with the same flow: the words are read
// (intent.ts), what they name is found on the live page (record.locate: the page's structure
// first, then the AI assistant; text that shows for a check) and shown for Confirm. With it off,
// steps that act on the page are added by clicking or drawing on it only, and Write and Go to
// address keep their own boxes.
export const DESCRIBE_STEPS = true;
// =============================================================================

/** Actions added by pointing at the page: with describing off, the page is the only way. */
export function onPage(k: ActionKind): boolean { return POINT_KINDS.has(k) || k === 'checkpoint' || k === 'waitUntil'; }

export function composerInput(k: ActionKind, describe: boolean = DESCRIBE_STEPS): ComposerInput {
  if (onPage(k)) return describe ? 'describe' : 'none';
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

/** What to do on the page, where the describe box was (DESCRIBE_STEPS off). */
export function pageHint(k: ActionKind): string {
  switch (k) {
    case 'waitUntil': return 'Draw a box around what should appear on the page, or click it.';
    case 'checkpoint': return 'Click the area to check on the page, or draw a box around it.';
    case 'upload': return 'Pick a file, then click the upload field on the page.';
    case 'hover': return 'Click what to hover over on the page.';
    case 'doubleClick': return 'Click what to double-click on the page.';
    case 'longClick': return 'Click what to long-click on the page. The step holds the click down.';
    case 'rightClick': return 'Click what to right-click on the page.';
    case 'swipe': case 'scroll': return 'Drag on the page, or scroll it.';
    default: return 'Click on the page to add a step.';
  }
}

/** Hint row text for tools that need more than a click. */
export function toolHint(k: ActionKind, describe: boolean = DESCRIBE_STEPS): string | null {
  // Without the describe box, the bar itself says what to do for these (pageHint).
  if (!describe && (k === 'checkpoint' || k === 'waitUntil' || k === 'drag')) return null;
  // The file choice fills the bar, so what to do goes above it.
  if (!describe && k === 'upload') return pageHint(k);
  switch (k) {
    case 'drag': return 'Drag on the page from the start point to the end point, or click one and then the other.';
    // One way to say both: a drag sets direction and distance (and fills the fields); a click uses the fields.
    case 'swipe': case 'scroll': return 'Drag on the page to set the direction and distance, or click it to use the ones below.';
    case 'checkpoint': return 'Click or draw a box around what should be visible, or name it below.';
    case 'waitUntil': return 'Draw a box around what should appear, or describe it below.';
    default: return null;
  }
}

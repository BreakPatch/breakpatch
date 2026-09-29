// Plain-language names and icons for each action (ui-requirements §5.6 action list).
import type { ActionKind, Step } from '../data/types';

export interface ActionInfo { kind: ActionKind; name: string; verb: string; icon: string; group: 'Gestures' | 'Input' | 'Waiting' | 'Browser' | 'Structure' | 'Check' }

export const ACTIONS: ActionInfo[] = [
  { kind: 'click', name: 'Click', verb: 'Click', icon: 'touch_app', group: 'Gestures' },
  { kind: 'doubleClick', name: 'Double click', verb: 'Double click', icon: 'ads_click', group: 'Gestures' },
  { kind: 'longClick', name: 'Long click', verb: 'Long click', icon: 'back_hand', group: 'Gestures' },
  { kind: 'rightClick', name: 'Right click', verb: 'Right click', icon: 'right_click', group: 'Gestures' },
  { kind: 'hover', name: 'Hover', verb: 'Hover over', icon: 'arrow_selector_tool', group: 'Gestures' },
  { kind: 'swipe', name: 'Swipe', verb: 'Swipe', icon: 'swipe', group: 'Gestures' },
  { kind: 'scroll', name: 'Scroll', verb: 'Scroll', icon: 'swap_vert', group: 'Gestures' },
  { kind: 'drag', name: 'Drag and drop', verb: 'Drag', icon: 'drag_pan', group: 'Gestures' },
  { kind: 'write', name: 'Write text', verb: 'Write', icon: 'keyboard', group: 'Input' },
  { kind: 'waitUntil', name: 'Wait until something appears', verb: 'Wait until', icon: 'hourglass_top', group: 'Waiting' },
  { kind: 'waitFor', name: 'Wait for a set time', verb: 'Wait', icon: 'timer', group: 'Waiting' },
  { kind: 'navigate', name: 'Go to address', verb: 'Go to', icon: 'open_in_browser', group: 'Browser' },
  { kind: 'switchTab', name: 'Switch to new tab or popup', verb: 'Switch to', icon: 'tab', group: 'Browser' },
  { kind: 'upload', name: 'Upload file', verb: 'Upload', icon: 'upload_file', group: 'Browser' },
  { kind: 'downloadCheck', name: 'Check a download', verb: 'Check download', icon: 'download_done', group: 'Browser' },
  { kind: 'checkpoint', name: 'Also check something is visible', verb: 'Check', icon: 'fact_check', group: 'Check' },
  { kind: 'loop', name: 'Repeat steps', verb: 'Repeat', icon: 'repeat', group: 'Structure' },
  { kind: 'group', name: 'Insert shared steps', verb: 'Shared steps', icon: 'account_tree', group: 'Structure' },
];

const BY_KIND = Object.fromEntries(ACTIONS.map(a => [a.kind, a])) as Record<ActionKind, ActionInfo>;
export function actionInfo(kind: ActionKind): ActionInfo { return BY_KIND[kind]; }

const SAMPLE_NAMES = { docx: 'Word document', pdf: 'PDF', jpeg: 'JPEG image', mp4: 'MP4 video', xlsx: 'Excel sheet', csv: 'CSV file' } as const;
export const SAMPLES = SAMPLE_NAMES;

/** Default label for a step, before the user edits it. */
export function labelFor(kind: ActionKind, p: Partial<Step> = {}): { verb: string; label: string } {
  const a = BY_KIND[kind];
  switch (kind) {
    case 'write':
      return { verb: a.verb, label: p.secretRef ? `Write saved secret ${p.secretRef}` : p.generated ? `Write ${GENERATED[p.generated]}` : `Write "${p.text ?? ''}"` };
    case 'waitFor': return { verb: a.verb, label: `Wait ${Math.round((p.durationMs ?? 1000) / 1000)} seconds` };
    case 'navigate':
      return { verb: a.verb, label: p.nav === 'reload' ? 'Reload the page' : p.nav === 'back' ? 'Go back' : p.nav === 'forward' ? 'Go forward' : `Go to ${p.url ?? 'address'}` };
    case 'upload': return { verb: a.verb, label: `Upload ${p.sample ? SAMPLE_NAMES[p.sample] : 'a file'}` };
    case 'loop': return { verb: a.verb, label: `Repeat ${p.count ?? 2} times` };
    case 'scroll': case 'swipe': return { verb: a.verb, label: `${a.verb} ${p.direction ?? 'down'}` };
    default: return { verb: a.verb, label: a.verb + ' here' };
  }
}

export const GENERATED = { uniqueName: 'a unique name', timeNow: 'the time now', today: "today's date", repeatNumber: 'the repeat number' } as const;
/** The same values as choices in a menu, in sentence case like every menu: "A unique name". */
export const GENERATED_CHOICES = (Object.keys(GENERATED) as (keyof typeof GENERATED)[])
  .map(value => ({ value, label: GENERATED[value][0].toUpperCase() + GENERATED[value].slice(1) }));

// Plain-language text for step rows: icons, default labels and notes.
import type { Generated, Step } from '../../data/types';
import { actionInfo, GENERATED, labelFor, SAMPLES } from '../../engine/labels';

/** Tokens the engine replaces at run time (engine/PROTOCOL.md) and how the UI names them. */
export const TOKENS = [
  { token: '{i}', name: 'Repeat number', shown: '{repeat}' },
  { token: '{time}', name: 'Time now', shown: '{time}' },
  { token: '{date}', name: "Today's date", shown: '{date}' },
] as const;

/** Text as shown in labels: `{i}` reads as `{repeat}`. */
export function friendlyText(text: string): string {
  return text.replace(/\{i\}/g, '{repeat}');
}

/** "Note 1, Note 2…" for text that uses the repeat number, else undefined. */
export function repeatPreview(text: string | undefined): string | undefined {
  if (!text || !text.includes('{i}')) return undefined;
  return `${text.replace(/\{i\}/g, '1')}, ${text.replace(/\{i\}/g, '2')}…`;
}

export function stepIcon(s: Pick<Step, 'action' | 'nav' | 'secretRef'>): string {
  if (s.action === 'navigate' && s.nav && s.nav !== 'url') return { reload: 'refresh', back: 'arrow_back', forward: 'arrow_forward' }[s.nav];
  if (s.action === 'write' && s.secretRef) return 'key';
  return actionInfo(s.action)?.icon ?? 'radio_button_checked';
}

/** A typed value written into a masked field reads as dots in the list (an eye shows it). */
export const MASKED_LABEL = 'Write "••••••••"';

/** Default label for a new step (the user can rename it later). */
export function defaultLabel(p: Partial<Step> & { action: Step['action'] }): string {
  switch (p.action) {
    case 'write':
      if (p.secretRef) return `Write saved secret ${p.secretRef}`;
      if (p.generated) return `Write ${GENERATED[p.generated as Generated]}`;
      if (p.masked) return MASKED_LABEL;
      return `Write "${friendlyText(p.text ?? '')}"`;
    case 'waitUntil': return 'Wait until something appears';
    case 'waitFor': return `Wait ${Math.round((p.durationMs ?? 1000) / 1000)} seconds`;
    case 'switchTab': return 'Switch to the new tab';
    case 'downloadCheck': return p.fileType ? `Check a ${p.fileType.toUpperCase()} file downloaded` : 'Check a file downloaded';
    case 'upload': return p.file ? `Upload ${p.file.replace(/^files\//, '')}` : `Upload ${p.sample ? SAMPLES[p.sample] : 'a file'}`;
    case 'checkpoint': return 'Check something is visible';
    case 'swipe': case 'scroll': return `${actionInfo(p.action).verb} ${p.direction ?? 'down'}`;
    case 'drag': return 'Drag and drop';
    default: return labelFor(p.action, p).label;
  }
}

/** Second line under a label, when there is something useful to say. */
export function stepNote(s: Step, opts: { range?: [number, number] } = {}): string | undefined {
  if (s.action === 'loop') return !opts.range ? 'No steps yet' : opts.range[0] === opts.range[1] ? `Step ${opts.range[0]}` : `Steps ${opts.range[0]} to ${opts.range[1]}`;
  if (s.action === 'group') return s.groupVersion === 'latest' || s.groupVersion === undefined ? 'Shared steps · always latest' : `Shared steps · version ${s.groupVersion}`;
  if (s.action === 'write') return repeatPreview(s.text);
  return undefined;
}

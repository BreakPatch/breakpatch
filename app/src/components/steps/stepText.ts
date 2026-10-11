// Plain-language text for step rows: icons, default labels and notes.
import type { Generated, Step } from '../../data/types';
import { actionInfo, callLabel, GENERATED, labelFor, SAMPLES } from '../../engine/labels';

/** Tokens the engine replaces at run time (engine/PROTOCOL.md) and how the UI names them. */
export const TOKENS = [
  { token: '{i}', name: 'Repeat number', shown: '{repeat}' },
  { token: '{time}', name: 'Time now', shown: '{time}' },
  { token: '{date}', name: "Today's date", shown: '{date}' },
] as const;

/**
 * Tokens for the test inbox (Breakpatch Team, engine/PROTOCOL.md "Wait for an email"): the run's own
 * address, and what a Wait for an email step before picked out. Offered only with the `email` feature.
 */
export const EMAIL_TOKENS = [
  { token: '{email}', name: 'Test inbox address', shown: '{email}' },
  { token: '{emailCode}', name: 'Code from the email', shown: '{emailCode}' },
  { token: '{emailLink}', name: 'Link from the email', shown: '{emailLink}' },
] as const;

/** What a Write step's `valueRef` reads as: "the code from the email", or the Call step value's name. */
export function valueName(ref: string): string {
  return ref === 'emailCode' ? 'the code from the email' : ref === 'emailLink' ? 'the link from the email' : `the value ${ref}`;
}

/** Text as shown in labels: `{i}` reads as `{repeat}`. */
export function friendlyText(text: string): string {
  return text.replace(/\{i\}/g, '{repeat}');
}

/** "Note 1, Note 2…" for text that uses the repeat number, else undefined. */
export function repeatPreview(text: string | undefined): string | undefined {
  if (!text || !text.includes('{i}')) return undefined;
  return `${text.replace(/\{i\}/g, '1')}, ${text.replace(/\{i\}/g, '2')}…`;
}

export function stepIcon(s: Pick<Step, 'action' | 'nav' | 'secretRef'> & Partial<Pick<Step, 'valueRef'>>): string {
  if (s.action === 'navigate' && s.nav && s.nav !== 'url') return { reload: 'refresh', back: 'arrow_back', forward: 'arrow_forward' }[s.nav];
  if (s.action === 'write' && s.secretRef) return 'key';
  if (s.action === 'write' && s.valueRef) return 'data_object';
  return actionInfo(s.action)?.icon ?? 'radio_button_checked';
}

export { UNCHECKED_NOTE } from '../../lib/runWords';
import { UNCHECKED_NOTE } from '../../lib/runWords';

/**
 * What a closed row shows of a long note, so it fits on one line (DES-04): "Slow: 5.2 s waiting
 * for the page", "Check covers nothing". The whole note is its tooltip and shows when the card opens.
 */
export function shortNote(note: string): string {
  if (note === UNCHECKED_NOTE) return 'Check covers nothing';
  const slow = /^Took [\d.]+ s: ([\d.]+ s) (waiting for the page|doing the step)/.exec(note);
  return slow ? `Slow: ${slow[1]} ${slow[2]}` : note;
}

/** A typed value written into a masked field reads as dots in the list (an eye shows it). */
export const MASKED_LABEL = 'Write "••••••••"';

/** Default label for a new step (the user can rename it later). */
export function defaultLabel(p: Partial<Step> & { action: Step['action'] }): string {
  switch (p.action) {
    case 'write':
      if (p.secretRef) return `Write saved secret ${p.secretRef}`;
      if (p.valueRef) return `Write ${valueName(p.valueRef)}`;
      if (p.generated) return `Write ${GENERATED[p.generated as Generated]}`;
      if (p.masked) return MASKED_LABEL;
      // A step imported from a script can end by pressing Enter (typed as a line break).
      if (p.text === '\n') return 'Press Enter';
      if (p.text?.endsWith('\n')) return `Write "${friendlyText(p.text.slice(0, -1))}" and press Enter`;
      return `Write "${friendlyText(p.text ?? '')}"`;
    case 'waitUntil': return 'Wait until something appears';
    case 'waitFor': return `Wait ${Math.round((p.durationMs ?? 1000) / 1000)} seconds`;
    case 'switchTab': return 'Switch to the new tab';
    case 'downloadCheck': return p.fileType ? `Check a ${p.fileType.toUpperCase()} file downloaded` : 'Check a file downloaded';
    case 'upload': return p.file ? `Upload ${p.file.replace(/^files\//, '')}` : `Upload ${p.sample ? SAMPLES[p.sample] : 'a file'}`;
    case 'checkpoint': return 'Check something is visible';
    case 'swipe': case 'scroll': return `${actionInfo(p.action).verb} ${p.direction ?? 'down'}`;
    case 'drag': return 'Drag and drop';
    case 'call': return callLabel(p.call);
    default: return labelFor(p.action, p).label;
  }
}

/** Second line under a label, when there is something useful to say. */
export function stepNote(s: Step, opts: { range?: [number, number] } = {}): string | undefined {
  if (s.action === 'loop') return !opts.range ? 'No steps yet' : opts.range[0] === opts.range[1] ? `Step ${opts.range[0]}` : `Steps ${opts.range[0]} to ${opts.range[1]}`;
  // Which version first: in a narrow row (a run) the end is cut off, and the icon already says shared steps.
  if (s.action === 'group') return s.groupVersion === 'latest' || s.groupVersion === undefined ? 'Always latest · shared steps' : `Version ${s.groupVersion} · shared steps`;
  if (s.action === 'write') return s.valueRef ? (s.valueRef === 'emailCode' || s.valueRef === 'emailLink' ? 'From the email' : 'From a Call step') : repeatPreview(s.text);
  if (s.action === 'call') return s.keep ? `Keeps ${s.keep.path} as ${s.keep.name}` : undefined;
  if (s.action === 'emailWait') return emailNote(s);
  return undefined;
}

/** "To the run's own address · keeps the code for {emailCode}": what a Wait for an email step waits for and keeps. */
export function emailNote(s: Pick<Step, 'email'>): string {
  const e = s.email ?? {};
  const to = !e.to || e.to === '{email}' ? "To the run's own address" : `To ${e.to}`;
  const keeps = e.pick === 'code' ? 'keeps the code for {emailCode}' : e.pick === 'link' ? 'keeps the link for {emailLink}' : undefined;
  return keeps ? `${to} · ${keeps}` : to;
}

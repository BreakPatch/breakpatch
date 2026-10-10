// Wait for an email (Breakpatch Team, issue #12; engine/PROTOCOL.md "Wait for an email"): what the
// open app knows of it. The Team module adds the step (the recorder's action list) and the test
// inbox (Settings → Test inbox); every edition lists, names and saves such a step, and a run
// without Team fails it with `actionUnavailable`.
import type { Backend } from '../data/backend';
import type { InboxSettings, Step } from '../data/types';

/** The tokens a run fills in from the test inbox: the run's own address, and what an email gave. */
const TOKENS = ['{email}', '{emailCode}', '{emailLink}'];

/** A Wait for an email step at any depth (tests folder and workspace formats: data/local/format.ts, Team's schema.ts). */
export function usesEmailSteps(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some(s => !!s && typeof s === 'object' && ((s as Step).action === 'emailWait' || usesEmailSteps((s as Step).steps)));
}

/** Whether a run of these steps needs the test inbox: a Wait for an email step, or `{email}`, `{emailCode}` or `{emailLink}` anywhere. */
export function usesEmail(steps: Step[]): boolean {
  return steps.some(s => s.action === 'emailWait'
    || [s.text, s.url, s.call?.url, s.call?.body].some(t => typeof t === 'string' && TOKENS.some(k => t.includes(k)))
    || usesEmail(s.steps ?? []));
}

/** Whether text uses the test inbox (a Write step's text, a Go to address). */
export const hasEmailToken = (text: string | undefined): boolean => !!text && TOKENS.some(k => text.includes(k));

/** The test inbox's password secret, when the steps wait for an email (the engine checks it before the run). */
export function inboxSecretNames(steps: Step[], inbox: InboxSettings | null | undefined): string[] {
  return inbox?.passwordRef && usesEmailSteps(steps) ? [inbox.passwordRef] : [];
}

/** The open workspace's test inbox, once (null: none, or a backend without one, like a tests folder). */
export function readInbox(backend: Backend): Promise<InboxSettings | null> {
  const store = backend.inbox;
  if (!store) return Promise.resolve(null);
  return new Promise(resolve => {
    let done = false;
    let off: (() => void) | undefined;
    off = store.settings(v => {
      if (done) return;
      done = true;
      resolve(v);
      if (off) off();
    });
    if (done) off();
    // A store that never answers (offline, no access): the run goes on without one.
    setTimeout(() => { if (!done) { done = true; off?.(); resolve(null); } }, 5000);
  });
}

/** What a kept value is called where a Write step picks one: "The code from the email", or a Call step value's name. */
export function keptValueLabel(name: string): string {
  return name === 'emailCode' ? 'The code from the email' : name === 'emailLink' ? 'The link from the email' : name;
}

/** The Write step's choice for kept values: "From a call", "From the email", or "From an earlier step" for both. */
export function keptChoiceLabel(names: string[]): string {
  const email = names.some(n => n === 'emailCode' || n === 'emailLink');
  const call = names.some(n => n !== 'emailCode' && n !== 'emailLink');
  return email && call ? 'From an earlier step' : email ? 'From the email' : 'From a call';
}

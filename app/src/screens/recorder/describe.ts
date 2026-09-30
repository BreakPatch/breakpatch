// Text for the Describe flow (README "Describe flow").
import { REPEATABLE, type Intent } from './intent';

const VERBS = /^(please\s+)?(double[\s-]?click|right[\s-]?click|long[\s-]?click|click on|click|press|tap|hit|select|choose|find|hover over|hover|open|check that|check|upload to|upload)\s+/i;

/** "click the Done button" → "the Done button". The words the user used for the thing. */
export function describeWhat(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  const what = t.replace(VERBS, '').trim();
  return what || t;
}

export const thinkingText = (what: string) => `Looking for ${what}…`;
export const askText = (what: string) => `Is this ${what}?`;
/**
 * The question for what was found: "Is this the Done button?", then what Confirm does when that
 * isn't one plain click ("Confirm to click it 2 times.", "Confirm to type "hello" into it.").
 */
export function intentAskText(what: string, it: Pick<Intent, 'action' | 'repeat' | 'text' | 'direction'>): string {
  const q = askText(what);
  const times = it.repeat > 1 ? ` ${it.repeat} times` : '';
  const doing = ((): string | null => {
    switch (it.action) {
      case 'click': return times ? 'click it' : null;
      case 'doubleClick': return 'double click it';
      case 'rightClick': return 'right click it';
      case 'longClick': return 'long click it';
      case 'hover': return 'hover over it';
      case 'upload': return 'upload a file with it';
      case 'write': return `type "${it.text ?? ''}" into it`;
      case 'scroll': case 'swipe': return `${it.action} ${it.direction ?? 'down'} from there`;
      case 'checkpoint': return 'check it shows';
      case 'waitUntil': return 'wait until it shows';
      default: return null;
    }
  })();
  if (!doing) return q;
  return `${q} Confirm to ${doing}${REPEATABLE.has(it.action) ? times : ''}.`;
}
export const notFoundText = (what: string) => `Couldn't find "${what}" on this screen. Rephrase, or click it on the page.`;

/** A checkpoint's label from what the user typed: "success message" → "Success message shows". */
export function checkpointLabel(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  if (!t) return 'Check something is visible';
  const cap = t[0].toUpperCase() + t.slice(1);
  return /\b(shows|is visible|appears|visible)$/i.test(cap) ? cap : `${cap} shows`;
}

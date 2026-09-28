// Text for the Describe flow (README "Describe flow").

const VERBS = /^(please\s+)?(double[\s-]?click|right[\s-]?click|long[\s-]?click|click on|click|press|tap|hit|select|choose|find|hover over|hover|open|check that|check|upload to|upload)\s+/i;

/** "click the Done button" → "the Done button". The words the user used for the thing. */
export function describeWhat(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  const what = t.replace(VERBS, '').trim();
  return what || t;
}

export const thinkingText = (what: string) => `Looking for ${what}…`;
export const askText = (what: string) => `Is this ${what}?`;
export const notFoundText = (what: string) => `Couldn't find "${what}" on this screen. Rephrase, or click it on the page.`;

/** A checkpoint's label from what the user typed: "success message" → "Success message shows". */
export function checkpointLabel(text: string): string {
  const t = text.trim().replace(/[.?!]+$/, '');
  if (!t) return 'Check something is visible';
  const cap = t[0].toUpperCase() + t.slice(1);
  return /\b(shows|is visible|appears|visible)$/i.test(cap) ? cap : `${cap} shows`;
}

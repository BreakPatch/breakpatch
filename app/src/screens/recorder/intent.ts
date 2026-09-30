// What a described step asks for (the recorder's describe box, engine/PROTOCOL.md "What a
// described step means"). The sentence decides the action, what to act on and how many times:
// "add 2 people" is a click on the "+" next to "People", twice, whatever action is chosen. The
// chosen action is only used when the sentence names none ("the Done button").
//
// The words are read here first. When they start with a word this can't place ("log out the
// user"), the engine's AI assistant is asked (`record.intent`), when it's downloaded; failing
// that, the chosen action is used with the whole sentence as what to look for, as before.
import type { ActionKind, Direction } from '../../data/types';
import type { EngineIntent, Near } from '../../engine/engine';

export interface Intent {
  action: ActionKind;
  /** What to find on the page, in the user's words. None: the focused field (write), the page (scroll). */
  target?: string;
  /** How many steps to add, one after another (1 to MAX_REPEAT). */
  repeat: number;
  /** Write: what to type. */
  text?: string;
  /** Scroll: which way and how far (px). */
  direction?: Direction;
  distance?: number;
  /** Wait for a set time. */
  seconds?: number;
  /** Go to address. */
  url?: string;
  /** A stepper's "+" or "−" next to something (record.locate `near`). */
  near?: Near;
  /** Where the action came from: the sentence, the AI assistant, or the chosen action. */
  from: 'words' | 'ai' | 'chosen';
}

/**
 * `intent`: the sentence says what to do. `noVerb`: it only says what to act on ("the Done
 * button"), so the chosen action applies. `unsure`: it starts with a word this doesn't know; ask
 * the AI assistant, else treat it like `noVerb`. `unhandled`: it asks for something a step can't
 * do ("wait for the spinner to go away"); `message` says so, and nothing is looked for.
 */
export type Reading = { kind: 'intent'; intent: Intent } | { kind: 'noVerb' | 'unsure'; target: string } | { kind: 'unhandled'; message: string };

/** At most this many steps from one sentence. The engine's `record.intent` has the same limit (locator.py). */
export const MAX_REPEAT = 20;
/** Actions a sentence can ask for more than once ("click Next 3 times"): each time is a step of its own. */
export const REPEATABLE: ReadonlySet<ActionKind> = new Set<ActionKind>(['click', 'doubleClick', 'rightClick', 'longClick', 'hover', 'scroll', 'swipe', 'write']);
/** The actions the AI assistant may answer with (`record.intent`, engine/PROTOCOL.md). */
export const AI_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>(['click', 'doubleClick', 'rightClick', 'longClick', 'hover', 'write', 'scroll', 'waitFor', 'checkpoint']);
export const SCROLL_PX = 300;
const SCREEN_PX = 700;       // "a page", "scroll to the footer": about a screen
const FAR_PX = 5000;         // "to the top", "to the bottom"

const NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, another: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};
const NUM = `(?:\\d+|${Object.keys(NUMBERS).filter(k => k !== 'a' && k !== 'an' && k !== 'another').join('|')})`;

/** "2", "two", "a" → 2, 2, 1; anything else undefined. */
export function numberOf(word: string | undefined): number | undefined {
  if (!word) return undefined;
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  return NUMBERS[w];
}

const clamp = (n: number) => Math.max(1, Math.min(MAX_REPEAT, Math.round(n)));
const unquote = (s: string) => s.trim().replace(/^(["'“‘])(.*)\1$/s, '$2').replace(/^[“‘](.*)[”’]$/s, '$1').trim();
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Leading "please", "then", "now"…; trailing full stops. */
function clean(sentence: string): string {
  let s = sentence.trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  for (;;) {
    const next = s.replace(/^(?:please|then|now|and then|and|next|also|just|ok|okay)[,]?\s+/i, '').replace(/\s+please$/i, '');
    if (next === s) return s;
    s = next;
  }
}

/** "… 3 times", "… twice": the count, and the sentence without it. */
function takeRepeat(s: string): { rest: string; repeat?: number } {
  const times = new RegExp(`,?\\s+(${NUM})\\s+times$`, 'i').exec(s);
  if (times) return { rest: s.slice(0, times.index), repeat: numberOf(times[1]) };
  const word = /,?\s+(once|twice|thrice)$/i.exec(s);
  if (word) return { rest: s.slice(0, word.index), repeat: { once: 1, twice: 2, thrice: 3 }[word[1].toLowerCase() as 'once'] };
  const x = /\s+x\s?(\d+)$/i.exec(s);
  if (x) return { rest: s.slice(0, x.index), repeat: Number(x[1]) };
  return { rest: s };
}

// Words that start a noun phrase, so the sentence names no action ("the Done button").
const DETERMINERS = new Set(['the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'his', 'her', 'its', 'their',
  'some', 'any', 'each', 'every', 'first', 'second', 'third', 'last', 'next', 'previous', 'top', 'bottom', 'left', 'right', 'upper', 'lower']);
// Kinds of control at the end of a phrase ("Sign up button").
const ROLE_END = /\b(?:button|btn|link|tab|field|box|input|icon|menu|checkbox|option|item|row|card|toggle|switch|dropdown|image|logo|heading|title|banner|dialog|popup|pop-up|label|area|section|slider|picture|avatar|entry|cell)$/i;
// Words that are a button's own name as much as an action: "log out" is the Log out button.
const BUTTON_WORDS = new Set(['add', 'remove', 'delete', 'save', 'submit', 'send', 'continue', 'cancel', 'close', 'dismiss', 'accept', 'decline',
  'reject', 'buy', 'checkout', 'subscribe', 'apply', 'log', 'login', 'logout', 'sign', 'signin', 'signup', 'register', 'finish', 'done', 'ok',
  'start', 'create', 'edit', 'share', 'download', 'export', 'import', 'next', 'back', 'retry', 'refresh', 'search', 'filter', 'sort', 'reset',
  'copy', 'paste', 'undo', 'redo', 'play', 'pause', 'stop', 'skip', 'agree', 'allow', 'deny', 'upgrade', 'book', 'order', 'pay', 'join', 'follow', 'confirm']);

const INCREASE = 'add|increase|increment|raise|bump(?:\\s+up)?';
const DECREASE = 'remove|decrease|decrement|reduce|lower|subtract|take\\s+away';

function intent(action: ActionKind, more: Partial<Intent> = {}): Reading {
  const target = more.target?.trim();
  return { kind: 'intent', intent: { action, repeat: 1, ...more, ...(target ? { target } : { target: undefined }), from: 'words' } };
}

/** The "+" or "−" next to a thing, as what to look for, and as record.locate's `near`. */
export function stepperTarget(control: Near['control'], thing: string): { target: string; near: Near } {
  const of = cap(unquote(thing).replace(/^(?:the|a|an)\s+/i, '').trim());
  return { target: `the "${control === 'increase' ? '+' : '−'}" button next to "${of}"`, near: { control, of } };
}

function scroll(rest: string): Reading | null {
  const m = /^scroll(?:\s+(.*))?$/i.exec(rest);
  if (!m) return null;
  let s = (m[1] ?? '').trim();
  let direction: Direction | undefined;
  let distance = SCROLL_PX;
  let target: string | undefined;
  const ends = /^(?:(up|down|left|right)\s+)?(?:all\s+the\s+way\s+)?to\s+the\s+(top|bottom|end|start|beginning)(?:\s+of\s+(.+))?$/i.exec(s);
  if (ends) {
    direction = ends[2].toLowerCase() === 'top' || ends[2].toLowerCase() === 'start' || ends[2].toLowerCase() === 'beginning' ? 'up' : 'down';
    if (ends[1] === 'left' || ends[1] === 'right') direction = ends[1] as Direction;
    return intent('scroll', { direction, distance: FAR_PX, target: ends[3] });
  }
  // "scroll the list down"
  const obj = /^(.+?)\s+(up|down|left|right)$/i.exec(s);
  if (obj && !/^(?:by|a|to)\b/i.test(obj[1])) { target = obj[1]; s = obj[2]; }
  const dir = /^(up|down|left|right)\b\s*/i.exec(s);
  if (dir) { direction = dir[1].toLowerCase() as Direction; s = s.slice(dir[0].length); }
  const where = /(?:^|\s+)(?:in|on|inside|within|over)\s+(.+)$/i.exec(s);
  if (where) { target = where[1]; s = s.slice(0, where.index).trim(); }
  const px = /^(?:by\s+)?(\d+)\s*(?:px|pixels?)?$/i.exec(s);
  const pages = new RegExp(`^(?:by\\s+)?(a|one|${NUM})\\s+(?:page|screen)s?$`, 'i').exec(s);
  if (px) distance = Number(px[1]);
  else if (pages) distance = (numberOf(pages[1]) ?? 1) * SCREEN_PX;
  else if (/^a\s+(?:little|bit|little\s+bit)$/i.test(s)) distance = 150;
  else if (/^a\s+lot$/i.test(s)) distance = 1200;
  else if (/^(?:down\s+)?to\s+.+/i.test(s)) distance = SCREEN_PX;     // "to the pricing": about a screen that way
  else if (s) return null;
  return intent('scroll', { direction: direction ?? 'down', distance: Math.max(1, Math.min(FAR_PX, distance)), target });
}

function wait(rest: string): Reading | null {
  if (!/^wait\b/i.test(rest)) return null;
  const n = new RegExp(`^wait(?:\\s+for)?\\s+(${NUM}|a|an)\\s*(seconds?|secs?|s|minutes?|mins?|m)$`, 'i').exec(rest);
  if (n) {
    const v = numberOf(n[1]) ?? Number(n[1]);
    return intent('waitFor', { seconds: Math.min(600, /^m/i.test(n[2]) ? v * 60 : v) });
  }
  if (/^wait(?:\s+for)?(?:\s+a)?(?:\s+(?:moment|bit|second|sec|while))?$/i.test(rest)) return intent('waitFor', { seconds: 2 });
  // "wait for the spinner to go away": a Wait until waits for something to show, the opposite.
  if (/^wait\s+(?:until|till|for)\s+.+?\s+(?:(?:to\s+)?(?:go(?:es)?\s+away|disappears?|vanish(?:es)?|close[sd]?)|(?:to\s+be|is|are|has|have)\s+(?:gone|hidden|closed|no\s+longer\s+(?:there|visible|shown)|not\s+(?:there|visible|shown)))$/i.test(rest))
    return { kind: 'unhandled', message: "A step can't wait for something to go away yet. Use Wait for a set time, or Wait until for what shows next." };
  const until = /^wait\s+(?:until|till|for)\s+(.+?)(?:\s+(?:to\s+)?(?:appears?|shows?(?:\s+up)?|loads?|is\s+(?:visible|shown|displayed|there)|are\s+(?:visible|shown)|comes?\s+up))?$/i.exec(rest);
  if (until) return intent('waitUntil', { target: until[1] });
  return null;
}

function check(rest: string): Reading | null {
  const m = /^(?:(?:check|see|confirm)\s+(?:that|if|whether)|verify(?:\s+(?:that|if|whether))?|ensure(?:\s+that)?|assert(?:\s+that)?|make\s+sure(?:\s+that)?|expect|there\s+(?:is|are|should\s+be))\s+(.+)$/i.exec(rest);
  if (!m) return null;
  const what = m[1].replace(/\s+(?:is|are|should\s+be)?\s*(?:shown|showing|visible|displayed|there|present|on\s+(?:the\s+)?(?:page|screen))$/i, '')
    .replace(/\s+(?:appears?|shows?(?:\s+up)?)$/i, '').trim();
  return intent('checkpoint', { target: what || m[1] });
}

function write(rest: string): Reading | null {
  const quoted = /^(?:type|enter|write|input|put|key\s+in)\s+(["'“‘])(.+?)(?:\1|[”’])\s+(?:into|in|in\s+to|on)\s+(.+)$/i.exec(rest);
  if (quoted) return intent('write', { text: quoted[2], target: quoted[3] });
  const into = /^(?:type|enter|write|input|put|key\s+in)\s+(.+?)\s+(?:into|in\s+to)\s+(.+)$/i.exec(rest)
    ?? /^(?:type|enter|write|input|put|key\s+in)\s+(.+?)\s+(?:in|on)\s+(.+)$/i.exec(rest);
  if (into) return intent('write', { text: unquote(into[1]), target: into[2] });
  const fill = /^fill\s+(?:in\s+|out\s+)?(.+?)\s+with\s+(.+)$/i.exec(rest);
  if (fill) return intent('write', { text: unquote(fill[2]), target: fill[1] });
  const search = /^(?:search|look)\s+for\s+(.+)$/i.exec(rest);
  if (search) return intent('write', { text: unquote(search[1]), target: 'the search box' });
  // "fill in the form": what to fill, not what to type.
  if (/^fill\s+(?:in|out)\s+/i.test(rest) && ROLE_END.test(rest.replace(/\s+form$/i, ' field'))) return null;
  // "write 3", "put hello": into the field that has the focus.
  const bare = /^(?:type|enter|write|input|put|key\s+in|fill\s+in)\s+(.+)$/i.exec(rest);
  if (bare) return intent('write', { text: unquote(bare[1]) });
  return null;
}

function stepper(rest: string): Reading | null {
  // "add 2 people", "add another person", "remove 1 adult", "add 2 more seats"
  const counted = new RegExp(`^(${INCREASE}|${DECREASE})\\s+(${NUM}|another|one\\s+more)\\s+(?:more\\s+|extra\\s+|additional\\s+)?(.+)$`, 'i').exec(rest);
  // "increase people by 2", "decrease the number of rooms"
  const byVerb = /^(increase|increment|raise|bump\s+up|decrease|decrement|reduce|lower)\s+(?:the\s+)?(?:(?:number|count|amount|quantity)\s+of\s+)?(.+?)(?:\s+by\s+(\S+))?$/i.exec(rest);
  const m = counted ?? byVerb;
  if (!m) return null;
  // "add 2 items to the cart": a thing put somewhere, not a count next to a "+". The AI assistant may know.
  if (counted && /\s(?:to|into|onto|in|from|on|off)\s+\S/i.test(counted[3])) return { kind: 'unsure', target: rest };
  const verb = m[1].toLowerCase().replace(/\s+/g, ' ');
  const control: Near['control'] = new RegExp(`^(?:${INCREASE})$`, 'i').test(verb) ? 'increase' : 'decrease';
  const thing = counted ? counted[3] : byVerb![2];
  if (/\bto\s+\d+$/.test(thing)) return null;                  // "increase people to 3": depends on what's there now
  const n = counted ? (/^one\s+more$/i.test(counted[2]) ? 1 : numberOf(counted[2])) : (byVerb![3] ? numberOf(byVerb![3]) : 1);
  if (n === undefined) return null;
  const t = stepperTarget(control, thing);
  return intent('click', { ...t, repeat: clamp(n) });
}

function pointer(rest: string): Reading | null {
  const forms: [RegExp, ActionKind][] = [
    [/^double[\s-]?(?:click|tap)(?:\s+(?:on|at))?\s+(.+)$/i, 'doubleClick'],
    [/^right[\s-]?click(?:\s+(?:on|at))?\s+(.+)$/i, 'rightClick'],
    [/^(?:long[\s-]?(?:click|press|tap)|(?:press|tap|click)\s+and\s+hold)(?:\s+(?:on|at))?\s+(.+)$/i, 'longClick'],
    [/^(?:hover|mouse)(?:\s+(?:over|on|above))?\s+(.+)$/i, 'hover'],
    [/^(?:move\s+(?:the\s+)?(?:mouse|pointer|cursor)\s+(?:over|to|on)|point\s+(?:at|to))\s+(.+)$/i, 'hover'],
    [/^upload(?:\s+a\s+file)?\s+(?:to|with|using|into|via|in)\s+(.+)$/i, 'upload'],
    [/^upload\s+(.+)$/i, 'upload'],
    [/^(?:click|press|tap|hit|push|select|choose|pick|toggle|tick|untick|check|uncheck|activate|open|expand|collapse)(?:\s+(?:on|at))?\s+(.+)$/i, 'click'],
  ];
  // "select 2 adults": a number to set, which depends on what's there now, not a thing named "2 adults".
  if (new RegExp(`^(?:select|choose|pick)\\s+(?:${NUM})\\s+\\S`, 'i').test(rest)) return { kind: 'unsure', target: rest };
  for (const [re, action] of forms) {
    const m = re.exec(rest);
    if (m) return intent(action, { target: m[1] });
  }
  const go = /^(?:go|navigate|head)\s+(?:to|back\s+to)\s+(.+)$|^visit\s+(.+)$/i.exec(rest);
  if (go) {
    const where = (go[1] ?? go[2]).trim();
    if (/^(?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?:[/?#]\S*)?$/i.test(where)) return intent('navigate', { url: /^[a-z]+:\/\//i.test(where) ? where : `https://${where}` });
    return intent('click', { target: where });
  }
  return null;
}

/** Reads a described step. `sentence` as typed. */
export function readIntent(sentence: string): Reading {
  const whole = clean(sentence);
  const { rest, repeat } = takeRepeat(whole);
  const r = rest.trim();
  const got = wait(r) ?? check(r) ?? write(r) ?? scroll(r) ?? stepper(r) ?? pointer(r);
  if (got?.kind === 'intent') {
    const it = got.intent;
    if (repeat !== undefined && REPEATABLE.has(it.action)) it.repeat = clamp(repeat * it.repeat);
    return got;
  }
  if (got?.kind === 'unhandled') return got;
  if (got) return { kind: 'unsure', target: whole };
  const [first = '', second = ''] = r.toLowerCase().split(' ');
  // "click" and nothing else, or a verb whose object is missing: say what to look for instead.
  if (/^(?:click|press|tap|double|right|hover|type|enter|scroll|wait|check|verify)$/i.test(r)) return { kind: 'unsure', target: whole };
  // "Add a new item", "delete this row": a button's word, then what it acts on. ("Sign up button" isn't.)
  if (BUTTON_WORDS.has(first) && DETERMINERS.has(second)) return intent('click', { target: whole, repeat: repeat ? clamp(repeat) : 1 });
  if (DETERMINERS.has(first) || /^["'“‘\d]/.test(r) || ROLE_END.test(r)) return { kind: 'noVerb', target: whole };
  // A button's own words ("log out", "add to cart", "save"): click it.
  if (BUTTON_WORDS.has(first)) return intent('click', { target: whole, repeat: repeat ? clamp(repeat) : 1 });
  return { kind: 'unsure', target: whole };
}

/** The AI assistant's reading (record.intent) as an intent, or null when it doesn't add up. */
export function fromEngine(e: EngineIntent | null): Intent | null {
  if (!e) return null;
  if (!AI_ACTIONS.has(e.action as ActionKind)) return null;
  const action = e.action as ActionKind;
  if (action !== 'scroll' && action !== 'waitFor' && action !== 'write' && !e.target) return null;
  if (action === 'write' && !e.text) return null;
  if (action === 'waitFor' && !e.seconds) return null;
  const direction = ['up', 'down', 'left', 'right'].includes(e.direction ?? '') ? e.direction as Direction : undefined;
  return {
    action, repeat: clamp(e.repeat ?? 1), from: 'ai',
    ...(e.target ? { target: e.target } : {}), ...(e.text ? { text: e.text } : {}),
    ...(action === 'scroll' ? { direction: direction ?? 'down', distance: SCROLL_PX } : {}),
    ...(action === 'waitFor' ? { seconds: Math.min(600, e.seconds!) } : {}),
  };
}

/** When the sentence names no action: the chosen one, on what the sentence names. */
export function chosenIntent(target: string, chosen: ActionKind, o: { direction: Direction; distance: number; maxWait?: number }): Intent {
  const base = { target, repeat: 1, from: 'chosen' as const };
  if (chosen === 'scroll' || chosen === 'swipe') return { ...base, action: chosen, direction: o.direction, distance: o.distance };
  if (['click', 'doubleClick', 'longClick', 'rightClick', 'hover', 'upload', 'checkpoint', 'waitUntil'].includes(chosen)) return { ...base, action: chosen };
  return { ...base, action: 'click' };
}

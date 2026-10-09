// What to look for, in words, from a script's locator (roadmap #16). Breakpatch finds things by
// what they say and what they are (accessible names and roles, engine/PROTOCOL.md "Finding a
// described element"), never by CSS or XPath, so a locator becomes the words a person would use:
// getByRole('button', { name: 'Sign in' }) → the "Sign in" button. Words worked out from the page's
// code (an id, a data-cy attribute) are marked `guessed`, to be checked when the test is learned.

/** A locator in words. */
export interface Loc {
  /** The name or text to look for. */
  name?: string;
  /** A word for what it is ("button", "field"), when known. */
  role?: string;
  /** `name` is text on the page (getByText, cy.contains): said in quotes, without a role. */
  text?: boolean;
  /** 1-based, or -1 for the last one. */
  ordinal?: number;
  /** The words come from the page's code (an id, a test id, a name attribute), not what it shows: said without quotes. */
  code?: boolean;
  /** To check when it's learned: words from code that may not be what the page says, or a narrower locator made wider. */
  guessed?: boolean;
}

/** A locator that can't be put in words, with why. */
export interface NoLoc { why: string }
export const isLoc = (l: Loc | NoLoc): l is Loc => !('why' in l);

/** ARIA roles in the words S0 knows (engine dom/s0.py ROLE_WORDS). Roles not here are left unsaid. */
const ROLE_WORDS: Record<string, string> = {
  button: 'button', link: 'link', textbox: 'field', searchbox: 'search box', combobox: 'dropdown', listbox: 'dropdown',
  checkbox: 'checkbox', radio: 'radio button', switch: 'switch', tab: 'tab', menuitem: 'menu item', menuitemcheckbox: 'menu item',
  menuitemradio: 'menu item', option: 'option', heading: 'heading', img: 'image', image: 'image', slider: 'slider',
  spinbutton: 'field', row: 'row', cell: 'cell', gridcell: 'cell', listitem: 'item', treeitem: 'item', menu: 'menu',
};
export const roleWord = (role: string): string | undefined => ROLE_WORDS[role.toLowerCase()];

/** HTML tags in words. */
const TAG_WORDS: Record<string, string> = {
  button: 'button', a: 'link', input: 'field', textarea: 'field', select: 'dropdown', img: 'image', option: 'option',
  h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', li: 'item', tr: 'row', td: 'cell', th: 'cell',
};
const INPUT_TYPES: Record<string, string> = { checkbox: 'checkbox', radio: 'radio button', submit: 'button', button: 'button', search: 'search box' };

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
/** "first", "third", "last"; undefined past the tenth (S0 reads up to "tenth"). */
export function ordinalWord(n: number): string | undefined { return n === -1 ? 'last' : ORDINALS[n - 1]; }

/** "submitButton", "submit-btn", "user_email" → "submit button", "submit btn", "user email". */
export function idWords(id: string): string {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_.:/]+/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The locator in words: `the second "Delete" button`, `"Welcome back"`, `the email field`. */
export function targetWords(l: Loc): string {
  const ord = l.ordinal !== undefined ? ordinalWord(l.ordinal) : undefined;
  const name = l.name ? (l.code ? l.name : `"${l.name}"`) : '';
  if (l.text && !l.role) return ord ? `the ${ord} ${name}` : name;
  const parts = ['the', ord, name, l.role && !(l.code && endsWithRole(l.name, l.role)) ? l.role : undefined].filter(Boolean);
  return parts.length > 1 ? parts.join(' ') : name || 'the page';
}
/** "submit button" already says "button". */
function endsWithRole(name: string | undefined, role: string): boolean {
  return !!name && name.toLowerCase().endsWith(' ' + role.split(' ').pop()!) || name?.toLowerCase() === role;
}

/** A regular expression that is plain words ("/sign in/i", "/^Save$/"): those words, else undefined. */
export function regexWords(source: string): string | undefined {
  const s = source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\s\+|\\s\*|\\s/g, ' ').replace(/\\([.?!'’-])/g, '$1');
  return /^[\p{L}\p{N} '’.,!?&:-]+$/u.test(s) && s.trim() ? s.trim() : undefined;
}

const CSS_ONLY = "This picks an element by the page's code (its CSS classes or where it sits), which Breakpatch doesn't use: it finds things by what they say.";

/**
 * A selector (Playwright's `locator()`, `page.click(…)`; Cypress's `cy.get(…)`) in words, or why it
 * can't be. Playwright's own engines (`text=`, `role=`, `:has-text()`) say what something says, so
 * they aren't guesses; an id, a name or a test attribute only hints at it.
 */
export function selectorLoc(selector: string): Loc | NoLoc {
  let sel = selector.trim();
  // Playwright chains (`a >> b`) and CSS descendants: the last part names the element itself.
  if (sel.includes('>>')) sel = sel.split('>>').pop()!.trim();
  if (/^(xpath=|\/\/|\.\.?\/|\(\/\/)/.test(sel)) return { why: "This picks an element by an XPath, the page's structure, which Breakpatch doesn't use: it finds things by what they say." };
  const engine = /^(text|role|data-testid|data-test-id|data-test|id|internal:text|internal:role|internal:label|internal:testid)\s*=\s*(.+)$/s.exec(sel);
  if (engine) {
    const [, kind, rest] = engine;
    // text="Save"i: a quoted value may end in a flag.
    const val = unquote(rest.trim().replace(/^(["'])(.*)\1[is]$/s, '$1$2$1'));
    if (kind === 'text' || kind === 'internal:text') return { name: val, text: true };
    if (kind === 'internal:label') return { name: val, role: 'field' };
    if (kind === 'role' || kind === 'internal:role') {
      const m = /^([a-z]+)(?:\[name\s*=\s*(["'])(.*?)\2[is]?\])?/i.exec(rest.trim());
      if (!m) return { why: CSS_ONLY };
      return { ...(m[3] ? { name: m[3] } : {}), role: roleWord(m[1]) ?? m[1] };
    }
    // A test id is read by the fast locator itself (data-testid): not a guess.
    return { name: idWords(val), code: true, ...(kind === 'data-testid' || kind === 'internal:testid' ? {} : { guessed: true }) };
  }
  const last = lastCompound(sel);
  if (!last) return { why: CSS_ONLY };
  const tag = /^[a-z][a-z0-9-]*/i.exec(last)?.[0]?.toLowerCase();
  const attrs = new Map<string, string>();
  for (const m of last.matchAll(/\[\s*([\w:-]+)\s*(?:[~|^$*]?=\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*[is]?\s*\]/g)) attrs.set(m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '');
  const has = /:(?:has-text|text|text-is|contains)\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/.exec(last);
  const id = /#([\w-]+)/.exec(last)?.[1];
  const type = attrs.get('type')?.toLowerCase();
  const role = (tag === 'input' && type && INPUT_TYPES[type]) || (tag && TAG_WORDS[tag]) || (attrs.has('role') ? roleWord(attrs.get('role')!) : undefined)
    || (type === 'email' || type === 'password' || type === 'text' || type === 'tel' || type === 'number' ? 'field' : undefined);
  const withRole = (l: Loc): Loc => (role && !l.text ? { ...l, role } : role && l.text && tag ? { ...l, role, text: undefined } : l);
  // What it says: text, its accessible name, its placeholder, title or alt text.
  const said = has ? (has[1] ?? has[2] ?? has[3])?.trim() : undefined;
  if (said) return withRole({ name: said, text: true });
  for (const a of ['aria-label', 'placeholder', 'title', 'alt']) {
    const v = attrs.get(a);
    if (v) return withRole({ name: v });
  }
  // Hints from the code: a test attribute, a name, an id, a type, a value.
  const testId = attrs.get('data-testid');
  if (testId) return withRole({ name: idWords(testId), code: true });
  for (const a of ['data-test-id', 'data-test', 'data-cy', 'data-qa', 'data-e2e', 'name', 'for']) {
    const v = attrs.get(a);
    if (v) return withRole({ name: idWords(v), code: true, guessed: true });
  }
  if (id) return withRole({ name: idWords(id), code: true, guessed: true });
  const value = attrs.get('value');
  if (value && (tag === 'input' || tag === 'option' || tag === 'button')) return withRole({ name: value, guessed: true });
  if (type === 'email' || type === 'password' || type === 'search') return { name: type, role: type === 'search' ? 'search box' : 'field', code: true, guessed: true };
  if (type === 'submit') return { name: 'submit', role: 'button', code: true, guessed: true };
  // A bare tag ("h1", "button"): what it is, but not which one.
  if (role && last === tag) return { role, guessed: true };
  return { why: CSS_ONLY };
}

/** Said when a locator only says what something is ("a button"), not which one. */
export const WHICH = "This doesn't say which one to use (only what it is), so Breakpatch can't look for it.";

/** The last compound selector: `form .actions button[type=submit]` → `button[type=submit]`. */
function lastCompound(sel: string): string | undefined {
  // Only top-level spaces and combinators split: not those in [attr="a b"] or :has-text("a b").
  let depth = 0, quote = '', cut = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (depth === 0 && (c === ' ' || c === '>' || c === '+' || c === '~')) cut = i + 1;
    else if (depth === 0 && c === ',') return undefined;    // a list of selectors: no one element
  }
  const last = sel.slice(cut).trim();
  return last || undefined;
}

function unquote(s: string): string {
  const m = /^(["'])(.*)\1$/s.exec(s);
  return m ? m[2] : s;
}

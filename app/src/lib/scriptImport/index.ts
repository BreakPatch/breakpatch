// Import a Playwright or Cypress test (roadmap #16). The script is read, never run: its source is
// tokenized and the common patterns are mapped to Breakpatch steps, each with what to look for in
// words (locators.ts). Everything else is listed with a plain reason, never guessed at. The steps
// have no screen checks yet: the recorder learns them by doing each step once (plan.ts, `auto`),
// which records it exactly as if it had been clicked.
import type { WalkStep } from './walkStep';
import { dotted, Parser, str, type Chain, type Link, type Stmt, type Value } from './parse';
import { idWords, isLoc, regexWords, roleWord, selectorLoc, targetWords, WHICH, type Loc, type NoLoc } from './locators';

export type Framework = 'playwright' | 'cypress';

/** A step from the script, with where it came from. */
export interface ImportStep extends WalkStep {
  /** 1-based line in the script. */
  line: number;
  /** The script's code for it, on one line. */
  code: string;
  /** What to look for (or a value) was worked out from code, not from what the page says: check it. */
  guessed?: boolean;
  /** Write: the script reads the value from this setting or environment variable (a saved secret of that name may fit). */
  secretHint?: string;
  /** Said with the step in the list ("A drop-down: …"). */
  note?: string;
}

/** A line of the script that isn't a step, and why. `notNeeded`: Breakpatch does it by itself or it doesn't matter. */
export interface SkippedLine { line: number; code: string; why: string; notNeeded?: boolean }

export interface ImportedTest {
  name: string;
  /** The first address the script goes to, as written (it may be relative: "/login"). */
  startUrl?: string;
  /** The screen size the script sets, if it sets one. */
  viewport?: { width: number; height: number };
  steps: ImportStep[];
  skipped: SkippedLine[];
}

export interface ScriptImport {
  framework: Framework;
  tests: ImportedTest[];
}

/** The longest wait a step has (engine plan.MAX_WAIT_S). */
const MAX_WAIT_S = 60;
const CODE_MAX = 160;

// ---------- Words for the reasons ----------
const WHY = {
  block: "Conditions and loops aren't imported: a Breakpatch test does the same steps every time.",
  code: "This isn't a step: it works something out in code, and Breakpatch reads the script without running it.",
  helper: (name: string) => `${name}() is your own code, so Breakpatch can't see what it does. Add those steps by hand, or record them once as shared steps.`,
  custom: (name: string) => `cy.${name}() is a custom command from your project, so Breakpatch can't see what it does. Add those steps by hand, or record them once as shared steps.`,
  absent: "Checking that something isn't there isn't a step in Breakpatch yet.",
  address: "Breakpatch checks what's on the screen, not the page's address or title.",
  pageCode: (what: string) => `This checks ${what}, which is the page's code, not what shows. Breakpatch checks what shows after every step.`,
  value: 'This checks a value worked out in code, not the screen.',
  key: (key: string) => `Pressing ${key} isn't a step in Breakpatch yet. Only Enter is imported.`,
  clear: "Emptying a field isn't a step in Breakpatch: it types into the field as it is. Most forms start empty, so this is often fine.",
  upload: 'Uploads are added by hand: use Upload file and pick the file.',
  drag: 'Drag and drop is added by hand: drag on the page while recording.',
  scroll: "Scrolling to something isn't imported. If it's below the bottom of the screen, scroll the page when that step is learned.",
  mouse: 'This uses a position on the screen in pixels. Click the spot on the page instead when the test is learned.',
  modifiers: "A click with keys held down isn't a step in Breakpatch yet.",
  network: 'This works with the network or files in code, which a Breakpatch test doesn\'t do. A set-up or clean-up call can prepare data instead.',
  frame: 'Breakpatch finds things inside frames by itself.',
  reads: "This reads from the page in code. Breakpatch checks the screen after every step instead.",
  either: 'This looks for either of two things, which a step can\'t do.',
  structure: "This picks an element by where it sits in the page's code, which Breakpatch doesn't use: it finds things by what they say.",
  alias: "Cypress aliases aren't imported. Name what to look for in words instead.",
  callback: "Steps inside .within(), .then() or .each() aren't imported. Add them by hand when the test is learned.",
  special: (k: string) => `The key {${k}} isn't a step in Breakpatch yet. Only {enter} is imported.`,
  notWeb: 'Breakpatch only opens web addresses that start with https:// or http://.',
  // Not needed
  waits: 'Not needed: Breakpatch waits for the page to settle after every step.',
  browser: 'Not needed: Breakpatch opens its own browser.',
  settings: "Not needed: test settings aren't steps.",
  log: "Not needed: it doesn't change the page.",
  screenshot: 'Not needed: Breakpatch checks the screen after every step by itself.',
  focus: 'Not needed: clicking or typing puts the focus there.',
  viewport: 'Used as the new test\'s screen size.',
};

// ---------- One test's steps ----------

class Ctx {
  readonly steps: ImportStep[] = [];
  readonly skipped: SkippedLine[] = [];
  startUrl?: string;
  viewport?: { width: number; height: number };
  /** Names that hold a page: `page`, and popups (`page1` in codegen output). */
  readonly pages = new Set(['page']);
  /** Promises of a popup: `const page1Promise = page.waitForEvent('popup')`. */
  readonly popups = new Set<string>();
  /** Locators kept in a name: `const save = page.getByRole('button', { name: 'Save' })`. */
  readonly locators = new Map<string, Loc | NoLoc>();
  /** Plain values: `const email = 'ada@example.com'`. */
  readonly consts = new Map<string, string>();
  /** Values read from the environment: `const password = process.env.PASSWORD`. */
  readonly envs = new Map<string, string>();

  /** Reading declarations around the tests (top-level consts): nothing is listed or added. */
  quiet = false;

  add(step: WalkStep, at: Where, extra: Partial<ImportStep> = {}) {
    if (this.quiet) return;
    const clean = Object.fromEntries(Object.entries({ ...step, ...extra }).filter(([, v]) => v !== undefined && v !== false)) as unknown as WalkStep & Partial<ImportStep>;
    const last = this.steps[this.steps.length - 1];
    // A click into a field right before typing into it: typing clicks the field first anyway.
    if (clean.action === 'write' && clean.target && clean.text !== '\n' && last?.action === 'click' && last.target === clean.target) this.steps.pop();
    // Enter right after typing into the same field: one step, "Type "x" … and press Enter".
    const prev = this.steps[this.steps.length - 1];
    if (clean.action === 'write' && clean.text === '\n' && prev?.action === 'write' && prev.target === clean.target && prev.text !== undefined
      && !prev.text.endsWith('\n') && !prev.secretRef && !prev.needs && !prev.generated) {
      prev.text += '\n'; prev.code = cut(`${prev.code} ${at.code}`);
      return;
    }
    this.steps.push({ ...clean, line: at.line, code: at.code });
  }
  skip(at: Where, why: string, notNeeded = false) {
    if (this.quiet) return;
    this.skipped.push({ line: at.line, code: at.code, why, ...(notNeeded ? { notNeeded } : {}) });
  }
  /** The first address is where the test starts; later ones are Go to steps. */
  go(url: string, at: Where, guessed = false) {
    if (this.quiet) return;
    if (this.startUrl === undefined && this.steps.length === 0) { this.startUrl = url; return; }
    this.add({ action: 'navigate', url }, at, { guessed });
  }
}

interface Where { line: number; code: string }
const cut = (s: string) => (s.length > CODE_MAX ? s.slice(0, CODE_MAX - 1) + '…' : s);
const where = (s: { line: number; src: string }): Where => ({ line: s.line, code: cut(s.src) });

/** What a value types: text, a saved secret it may be, or nothing known. */
type Typed = { text: string; guessed?: boolean } | { secretHint: string } | { unknown: true };
function typed(v: Value | undefined, ctx: Ctx): Typed {
  if (!v) return { unknown: true };
  const s = str(v);
  if (s !== undefined) return { text: s };
  if (v.kind === 'chain') {
    const d = dotted(v.chain);
    if (d && ctx.consts.has(d)) return { text: ctx.consts.get(d)! };
    if (d && ctx.envs.has(d)) return { secretHint: ctx.envs.get(d)! };
    const env = envName(v.chain);
    if (env) return { secretHint: env };
  }
  if (v.kind === 'tmpl') {
    // `user-${Date.now()}@example.com`: a value made new on every run, like Breakpatch's {timestamp}.
    let guessed = false;
    const text = v.raw.replace(/\$\{\s*([^}]*?)\s*\}/g, (m, expr: string) => {
      if (/^(Date\.now\(\)|new Date\(\)\.getTime\(\)|Date\.now\(\)\.toString\(\)|\+new Date\(\))$/.test(expr)) { guessed = true; return '{timestamp}'; }
      if (/^[\w$]+$/.test(expr) && ctx.consts.has(expr)) return ctx.consts.get(expr)!;
      return m;
    });
    if (!text.includes('${')) return { text, ...(guessed ? { guessed } : {}) };
  }
  return { unknown: true };
}
/** `process.env.PASSWORD`, `process.env['PASSWORD']`, `Cypress.env('password')`: the name. */
function envName(c: Chain): string | undefined {
  const l = c.links;
  if (l[0]?.name === 'process' && l[1]?.name === 'env' && l[2]) return l[2].name === '[]' ? /\[\s*['"`]([\w.-]+)['"`]\s*\]/.exec(l[2].src)?.[1] : l[2].name;
  if (l[0]?.name === 'Cypress' && l[1]?.name === 'env') return str(l[1].args?.[0]);
  return undefined;
}

/** An address from a value: a string, a const, or `${BASE_URL}/login` (taken as /login on the app's address). */
function address(v: Value | undefined, ctx: Ctx): { url: string; guessed?: boolean } | undefined {
  const t = typed(v, ctx);
  if ('text' in t && !t.text.includes('{timestamp}')) return { url: t.text };
  if (v?.kind === 'tmpl') {
    const m = /^\$\{[^}]+\}(\/[^`$]*)$/.exec(v.raw);
    if (m) return { url: m[1], guessed: true };
  }
  if (v?.kind === 'other') {
    const m = /^[\w$.]+(?:\(\))?\s*\+\s*(['"])(\/[^'"]*)\1$/.exec(v.text);
    if (m) return { url: m[2], guessed: true };
  }
  return undefined;
}

/** Text a check looks for: a string, or a regex that is plain words. */
function shownText(v: Value | undefined, ctx: Ctx): string | undefined {
  if (v?.kind === 'regex') return regexWords(v.source);
  const t = typed(v, ctx);
  return 'text' in t && !t.guessed ? t.text : undefined;
}

/** A step that types `t` into `loc`: text, a value from the environment, or one the person gives when it's learned. */
function writeStep(ctx: Ctx, at: Where, loc: Loc | undefined, t: Typed, extra: Partial<ImportStep> = {}) {
  const target = loc ? targetWords(loc) : undefined;
  const guessed = !!loc?.guessed || extra.guessed;
  if ('text' in t) ctx.add({ action: 'write', target, text: t.text }, at, { ...extra, guessed: guessed || t.guessed });
  else if ('secretHint' in t) ctx.add({ action: 'write', target, needs: 'secret' }, at, { ...extra, guessed, secretHint: t.secretHint });
  else ctx.add({ action: 'write', target, needs: 'text' }, at, { ...extra, guessed });
}

/** Locators made from a label are fields to type into, checkboxes to tick, or plain things to click. */
function forAction(loc: Loc & { label?: boolean }, kind: 'write' | 'check' | 'select' | 'other'): Loc {
  const { label, ...l } = loc;
  if (!label) return kind === 'check' && !l.role ? { ...l, role: 'checkbox' } : kind === 'write' && !l.role && !l.text ? { ...l, role: 'field' } : l;
  return { ...l, role: kind === 'write' ? 'field' : kind === 'check' ? 'checkbox' : kind === 'select' ? 'dropdown' : undefined };
}

/** A drop-down: click it, then the option. */
function selectSteps(ctx: Ctx, at: Where, loc: Loc, v: Value | undefined) {
  let option: string | undefined, guessed = false;
  if (v?.kind === 'obj') {
    option = str(v.props.label);
    if (option === undefined) { option = str(v.props.value); guessed = true; }
  } else {
    // A plain string is the option's value or its label: Playwright and Cypress try both.
    const t = typed(v, ctx);
    if ('text' in t) { option = t.text; guessed = true; }
  }
  if (option === undefined) { ctx.skip(at, WHY.code); return; }
  const list = forAction(loc, 'select');
  ctx.add({ action: 'click', target: targetWords(list) }, at, { guessed: list.guessed });
  ctx.add({ action: 'click', target: targetWords({ name: option, role: 'option' }) }, at, {
    guessed: guessed || list.guessed,
    note: "If it's the browser's own drop-down list, choose the option on the page when this step is learned.",
  });
}

// ---------- Playwright ----------

/** Links that make or narrow a locator, from `links[i]`: the locator and the first link after it. */
function pwLocator(links: Link[], i: number, base: (Loc & { label?: boolean }) | NoLoc | undefined, ctx: Ctx): [(Loc & { label?: boolean }) | NoLoc | undefined, number] {
  let loc = base;
  for (; i < links.length; i++) {
    const l = links[i], a = l.args ?? [];
    // Inside something named (a row, a list item): Breakpatch looks on the whole page, so check it's the right one.
    const scoped = !!loc && isLoc(loc) && (!!loc.name || loc.ordinal !== undefined) && /^(getBy|locator$)/.test(l.name);
    const name = (v: Value | undefined) => (v?.kind === 'regex' ? regexWords(v.source) : (() => { const t = typed(v, ctx); return 'text' in t ? t.text : undefined; })());
    const opts = a[1]?.kind === 'obj' ? a[1].props : {};
    const fail = (why: string): NoLoc => ({ why });
    switch (l.name) {
      case 'getByRole': {
        const role = str(a[0]), n = opts.name ? name(opts.name) : undefined;
        if (!role || (opts.name && n === undefined)) { loc = fail(WHY.code); break; }
        const w = roleWord(role);
        loc = n ? { name: n, ...(w ? { role: w } : {}) } : w ? { role: w } : fail(WHY.structure);
        break;
      }
      case 'getByText': { const n = name(a[0]); loc = n !== undefined ? { name: n, text: true } : fail(WHY.code); break; }
      case 'getByLabel': { const n = name(a[0]); loc = n !== undefined ? { name: n, label: true } : fail(WHY.code); break; }
      case 'getByPlaceholder': { const n = name(a[0]); loc = n !== undefined ? { name: n, role: 'field' } : fail(WHY.code); break; }
      case 'getByAltText': { const n = name(a[0]); loc = n !== undefined ? { name: n, role: 'image' } : fail(WHY.code); break; }
      case 'getByTitle': { const n = name(a[0]); loc = n !== undefined ? { name: n } : fail(WHY.code); break; }
      case 'getByTestId': { const n = name(a[0]); loc = n !== undefined ? { name: idWords(n), code: true } : fail(WHY.code); break; }
      case 'locator': case '$': {
        const sel = str(a[0]);
        if (sel === undefined) { loc = a[0]?.kind === 'chain' ? pwLocator(a[0].chain.links, 1, undefined, ctx)[0] : fail(WHY.code); break; }
        loc = selectorLoc(sel);
        const has = a[1]?.kind === 'obj' ? a[1].props.hasText : undefined;
        if (has && isLoc(loc)) { const n = name(has); if (n) loc = { ...loc, name: n, text: !loc.role, guessed: false, code: false }; }
        break;
      }
      case 'frameLocator': case 'frame': case 'contentFrame': case 'mainFrame': loc = undefined; break;
      case 'first': if (loc && isLoc(loc)) loc = { ...loc, ordinal: 1 }; break;
      case 'last': if (loc && isLoc(loc)) loc = { ...loc, ordinal: -1 }; break;
      case 'nth': {
        const n = a[0]?.kind === 'num' ? a[0].v : NaN;
        if (loc && isLoc(loc)) loc = Number.isInteger(n) && n >= -1 && n < 10 ? { ...loc, ordinal: n === -1 ? -1 : n + 1 } : { ...loc, guessed: true };
        break;
      }
      case 'filter': {
        const has = a[0]?.kind === 'obj' ? a[0].props.hasText : undefined;
        const n = has ? name(has) : undefined;
        if (loc && isLoc(loc)) loc = n && !loc.name ? { ...loc, name: n } : { ...loc, guessed: true };
        break;
      }
      case 'and': break;
      case 'or': loc = fail(WHY.either); break;
      default: return [loc, i];
    }
    if (scoped && loc && isLoc(loc)) loc = { ...loc, guessed: true };
  }
  return [loc, i];
}

/** Old-style page methods that take a selector first: page.click('#save'). */
const PAGE_SELECTOR_ACTIONS = new Set(['click', 'dblclick', 'tap', 'fill', 'type', 'press', 'check', 'uncheck', 'setChecked', 'hover', 'selectOption', 'focus', 'waitForSelector', 'setInputFiles', 'dragAndDrop', 'textContent', 'innerText', 'innerHTML', 'getAttribute', 'isVisible', 'isHidden', 'isChecked', 'isEnabled', 'isDisabled', 'inputValue', 'dispatchEvent']);
const PAGE_LOCATORS = new Set(['getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'locator', '$', 'frameLocator', 'mainFrame', 'frame']);

function pwExpr(chain: Chain, s: Where, ctx: Ctx) {
  const links = chain.links, root = links[0].name;
  if (root === 'expect') { pwExpect(chain, s, ctx); return; }
  if (root === 'test') {
    if (links[1]?.name === 'step') { const fn = links[1].args?.find(a => a.kind === 'fn'); if (fn?.kind === 'fn') for (const st of fn.body) pwStmt(st, ctx); return; }
    ctx.skip(s, WHY.settings, true); return;
  }
  if (root === 'console') { ctx.skip(s, WHY.log, true); return; }
  if (['browser', 'context', 'chromium', 'firefox', 'webkit', 'request'].includes(root) && !ctx.pages.has(root)) {
    if (root === 'request') { ctx.skip(s, WHY.network); return; }
    ctx.skip(s, WHY.browser, true); return;
  }
  if (ctx.locators.has(root)) { pwAct(links, 1, ctx.locators.get(root), s, ctx); return; }
  if (!ctx.pages.has(root)) { ctx.skip(s, links.length === 1 || links[0].args ? WHY.helper(root) : WHY.code); return; }
  const m = links[1];
  if (!m) return;
  const a = m.args ?? [];
  switch (m.name) {
    case 'goto': {
      const u = address(a[0], ctx);
      if (u) ctx.go(u.url, s, u.guessed); else ctx.skip(s, WHY.code);
      return;
    }
    case 'reload': ctx.add({ action: 'navigate', nav: 'reload' }, s); return;
    case 'goBack': ctx.add({ action: 'navigate', nav: 'back' }, s); return;
    case 'goForward': ctx.add({ action: 'navigate', nav: 'forward' }, s); return;
    case 'waitForTimeout': {
      const ms = a[0]?.kind === 'num' ? a[0].v : NaN;
      if (Number.isFinite(ms)) ctx.add({ action: 'waitFor', seconds: Math.min(MAX_WAIT_S, Math.max(1, Math.ceil(ms / 1000))) }, s);
      else ctx.skip(s, WHY.code);
      return;
    }
    case 'waitForLoadState': case 'waitForURL': case 'waitForNavigation': case 'waitForResponse': case 'waitForRequest': case 'waitForEvent':
      ctx.skip(s, WHY.waits, true); return;
    case 'waitForFunction': ctx.skip(s, WHY.code); return;
    case 'setViewportSize': {
      const vp = a[0]?.kind === 'obj' ? sizeOf(a[0]) : undefined;
      if (vp) { ctx.viewport ??= vp; ctx.skip(s, WHY.viewport, true); } else ctx.skip(s, WHY.code);
      return;
    }
    case 'screenshot': ctx.skip(s, WHY.screenshot, true); return;
    case 'pause': case 'bringToFront': case 'close': ctx.skip(s, WHY.browser, true); return;
    case 'keyboard': {
      const k = links[2], ka = k?.args ?? [];
      if (k?.name === 'type' || k?.name === 'insertText') { writeStep(ctx, s, undefined, typed(ka[0], ctx)); return; }
      if (k?.name === 'press') { const key = str(ka[0]); if (key === 'Enter') ctx.add({ action: 'write', text: '\n' }, s); else ctx.skip(s, WHY.key(key ?? 'a key')); return; }
      ctx.skip(s, WHY.key(str(ka[0]) ?? 'keys'));
      return;
    }
    case 'mouse': case 'touchscreen': ctx.skip(s, WHY.mouse); return;
    case 'evaluate': case 'evaluateHandle': case 'addInitScript': case 'addScriptTag': case 'addStyleTag': case 'exposeFunction': case 'exposeBinding': case 'on': case 'once': case 'route': case 'unroute': case 'setExtraHTTPHeaders': case 'context': case 'request': case 'emulateMedia': case 'setDefaultTimeout': case 'setDefaultNavigationTimeout':
      ctx.skip(s, m.name === 'route' || m.name === 'request' ? WHY.network : WHY.code); return;
    case 'title': case 'url': case 'content': ctx.skip(s, WHY.reads); return;
  }
  if (PAGE_LOCATORS.has(m.name)) { pwAct(links, 1, undefined, s, ctx); return; }
  if (PAGE_SELECTOR_ACTIONS.has(m.name)) {
    // page.click('#save', opts) = page.locator('#save').click(opts)
    const sel = str(a[0]);
    const loc = sel !== undefined ? selectorLoc(sel) : { why: WHY.code };
    pwAction(loc, { ...m, args: a.slice(1) }, s, ctx);
    return;
  }
  ctx.skip(s, WHY.code);
}

/** A locator chain from `links[i]` and the action at its end. */
function pwAct(links: Link[], i: number, base: Loc | NoLoc | undefined, s: Where, ctx: Ctx) {
  const [loc, k] = pwLocator(links, i, base, ctx);
  const act = links[k];
  if (!act) return;            // a locator on its own does nothing
  pwAction(loc ?? { why: WHY.structure }, act, s, ctx);
}

/** One Playwright action on a locator. */
function pwAction(loc: (Loc & { label?: boolean }) | NoLoc, act: Link, s: Where, ctx: Ctx) {
  const a = act.args ?? [];
  const opts = a[0]?.kind === 'obj' ? a[0].props : {};
  const need = (fn: (l: Loc & { label?: boolean }) => void) => (!isLoc(loc) ? ctx.skip(s, loc.why) : !loc.name ? ctx.skip(s, WHICH) : fn(loc));
  switch (act.name) {
    case 'click': case 'tap': return need(l => {
      if (opts.modifiers) { ctx.skip(s, WHY.modifiers); return; }
      const button = str(opts.button), count = opts.clickCount?.kind === 'num' ? opts.clickCount.v : 1;
      const action = button === 'right' ? 'rightClick' : count >= 2 ? 'doubleClick' : 'click';
      const t = forAction(l, 'other');
      ctx.add({ action, target: targetWords(t) }, s, { guessed: t.guessed });
    });
    case 'dblclick': return need(l => { const t = forAction(l, 'other'); ctx.add({ action: 'doubleClick', target: targetWords(t) }, s, { guessed: t.guessed }); });
    case 'hover': return need(l => { const t = forAction(l, 'other'); ctx.add({ action: 'hover', target: targetWords(t) }, s, { guessed: t.guessed }); });
    case 'check': case 'uncheck': case 'setChecked': return need(l => { const t = forAction(l, 'check'); ctx.add({ action: 'click', target: targetWords(t) }, s, { guessed: t.guessed }); });
    case 'fill': case 'type': case 'pressSequentially': return need(l => {
      if (str(a[0]) === '') { ctx.skip(s, WHY.clear); return; }
      writeStep(ctx, s, forAction(l, 'write'), typed(a[0], ctx));
    });
    case 'clear': ctx.skip(s, WHY.clear); return;
    case 'press': return need(l => {
      const key = str(a[0]);
      if (key === 'Enter') { const t = forAction(l, 'write'); ctx.add({ action: 'write', target: targetWords(t), text: '\n' }, s, { guessed: t.guessed }); }
      else ctx.skip(s, WHY.key(key ?? 'a key'));
    });
    case 'selectOption': return need(l => selectSteps(ctx, s, l, a[0]));
    case 'waitFor': case 'waitForSelector': return need(l => {
      const o = (act.name === 'waitForSelector' ? a[1] : a[0]);
      const state = o?.kind === 'obj' ? str(o.props.state) : undefined;
      if (state === 'hidden' || state === 'detached') { ctx.skip(s, WHY.absent); return; }
      const t = forAction(l, 'other');
      ctx.add({ action: 'waitUntil', target: targetWords(t) }, s, { guessed: t.guessed });
    });
    case 'focus': case 'blur': case 'highlight': ctx.skip(s, WHY.focus, true); return;
    case 'scrollIntoViewIfNeeded': ctx.skip(s, WHY.scroll); return;
    case 'setInputFiles': ctx.skip(s, WHY.upload); return;
    case 'dragTo': case 'dragAndDrop': ctx.skip(s, WHY.drag); return;
    case 'screenshot': ctx.skip(s, WHY.screenshot, true); return;
    case 'textContent': case 'innerText': case 'innerHTML': case 'getAttribute': case 'isVisible': case 'isHidden': case 'isChecked': case 'isEnabled': case 'isDisabled': case 'isEditable':
    case 'inputValue': case 'count': case 'all': case 'allTextContents': case 'allInnerTexts': case 'boundingBox': case 'evaluate': case 'evaluateAll': case 'elementHandle': case 'ariaSnapshot':
      ctx.skip(s, WHY.reads); return;
    case 'dispatchEvent': ctx.skip(s, WHY.code); return;
    default: ctx.skip(s, isLoc(loc) ? WHY.code : loc.why);
  }
}

const PAGE_CODE: Record<string, string> = {
  toBeChecked: 'whether it is ticked', toBeEnabled: 'whether it is enabled', toBeDisabled: 'whether it is disabled', toBeEditable: 'whether it can be edited',
  toBeEmpty: 'whether it is empty', toBeFocused: 'where the focus is', toBeAttached: 'whether it is in the page', toBeInViewport: 'whether it is on screen',
  toHaveValue: "a field's value", toHaveValues: "a list's values", toHaveAttribute: 'an attribute', toHaveClass: 'a CSS class', toContainClass: 'a CSS class', toHaveCount: 'how many there are',
  toHaveCSS: 'a style', toHaveId: 'an id', toHaveJSProperty: 'a property', toHaveAccessibleName: 'an accessible name', toHaveAccessibleDescription: 'an accessible description',
  toHaveRole: 'a role', toHaveAccessibleErrorMessage: 'an error message', toMatchAriaSnapshot: 'the accessibility tree',
};

function pwExpect(chain: Chain, s: Where, ctx: Ctx) {
  const links = chain.links;
  // expect(x), expect.soft(x), expect(x, 'message')
  const callIdx = links[0].args ? 0 : links[1]?.name === 'soft' && links[1].args ? 1 : -1;
  if (callIdx < 0) { ctx.skip(s, WHY.value); return; }
  const subject = links[callIdx].args?.[0];
  const rest = links.slice(callIdx + 1);
  const not = rest.some(l => l.name === 'not');
  const matcher = rest.find(l => l.args);
  if (!matcher || !subject || subject.kind !== 'chain') { ctx.skip(s, WHY.value); return; }
  const m = matcher.name;
  if (m === 'toHaveScreenshot' || m === 'toMatchSnapshot') { ctx.skip(s, WHY.screenshot, true); return; }
  const sub = subject.chain.links, root = sub[0].name;
  const isPage = ctx.pages.has(root) && sub.length === 1;
  if (isPage) { ctx.skip(s, m === 'toHaveURL' || m === 'toHaveTitle' ? WHY.address : WHY.value); return; }
  let loc: (Loc & { label?: boolean }) | NoLoc | undefined;
  if (ctx.locators.has(root)) loc = pwLocator(sub, 1, ctx.locators.get(root), ctx)[0];
  else if (ctx.pages.has(root)) loc = pwLocator(sub, 1, undefined, ctx)[0];
  else { ctx.skip(s, WHY.value); return; }
  if (not || m === 'toBeHidden') { ctx.skip(s, WHY.absent); return; }
  if (PAGE_CODE[m]) { ctx.skip(s, WHY.pageCode(PAGE_CODE[m])); return; }
  const arg = matcher.args?.[0];
  if (m === 'toBeVisible') {
    if (arg?.kind === 'obj' && arg.props.visible?.kind === 'bool' && !arg.props.visible.v) { ctx.skip(s, WHY.absent); return; }
    if (!loc || !isLoc(loc)) { ctx.skip(s, loc?.why ?? WHY.structure); return; }
    if (!loc.name) { ctx.skip(s, WHICH); return; }
    const t = forAction(loc, 'other');
    ctx.add({ action: 'checkpoint', target: targetWords(t) }, s, { guessed: t.guessed });
    return;
  }
  if (m === 'toHaveText' || m === 'toContainText') {
    const text = shownText(arg, ctx);
    if (text === undefined) { ctx.skip(s, arg?.kind === 'arr' ? WHY.pageCode('a list of texts') : WHY.code); return; }
    // The text, said with what it is when the locator only said that ("the heading").
    const l = loc && isLoc(loc) ? forAction(loc, 'other') : undefined;
    const t: Loc = l?.role && !l.name ? { name: text, role: l.role } : { name: text, text: true };
    ctx.add({ action: 'checkpoint', target: targetWords(t) }, s);
    return;
  }
  ctx.skip(s, WHY.value);
}

function sizeOf(v: Extract<Value, { kind: 'obj' }>): { width: number; height: number } | undefined {
  const w = v.props.width, h = v.props.height;
  return w?.kind === 'num' && h?.kind === 'num' && w.v >= 200 && h.v >= 200 ? { width: Math.round(w.v), height: Math.round(h.v) } : undefined;
}

function decl(s: Extract<Stmt, { kind: 'decl' }>, ctx: Ctx, onChain: (c: Chain, at: Where) => void) {
  const at = where(s);
  const v = s.init;
  if (!s.name || !v) { ctx.skip(at, WHY.code); return; }
  const text = typed(v, ctx);
  if ('text' in text && !text.guessed) { ctx.consts.set(s.name, text.text); return; }
  if ('secretHint' in text) { ctx.envs.set(s.name, text.secretHint); return; }
  // `const user = { email: 'ada@example.com', password: process.env.PASSWORD }`: user.email, user.password.
  if (v.kind === 'obj') {
    for (const [k, pv] of Object.entries(v.props)) {
      const t = typed(pv, ctx);
      if ('text' in t && !t.guessed) ctx.consts.set(`${s.name}.${k}`, t.text);
      else if ('secretHint' in t) ctx.envs.set(`${s.name}.${k}`, t.secretHint);
    }
    return;
  }
  if (v.kind !== 'chain') { ctx.skip(at, WHY.code); return; }
  const links = v.chain.links, root = links[0].name;
  // Popups: `const page1Promise = page.waitForEvent('popup')`, then `const page1 = await page1Promise`.
  const isPopup = (ctx.pages.has(root) || root === 'context') && links[1]?.name === 'waitForEvent' && ['popup', 'page'].includes(str(links[1].args?.[0]) ?? '');
  if (isPopup && !v.awaited) { ctx.popups.add(s.name); return; }
  if ((isPopup && v.awaited) || (ctx.popups.has(root) && links.length === 1)) {
    ctx.pages.add(s.name);
    ctx.add({ action: 'switchTab' }, at);
    return;
  }
  if (links.length === 2 && links[1].name === 'newPage') { ctx.pages.add(s.name); ctx.skip(at, WHY.browser, true); return; }
  if (['chromium', 'firefox', 'webkit', 'browser'].includes(root) && !ctx.pages.has(root)) {
    const opts = links[links.length - 1].args?.[0];
    if (links[links.length - 1].name === 'newContext' && opts?.kind === 'obj' && opts.props.viewport?.kind === 'obj') ctx.viewport ??= sizeOf(opts.props.viewport);
    ctx.skip(at, WHY.browser, true); return;
  }
  // A locator kept in a name, for later lines.
  if (ctx.pages.has(root) && links.length > 1 && PAGE_LOCATORS.has(links[1].name)) {
    const [loc, k] = pwLocator(links, 1, undefined, ctx);
    if (k === links.length) { ctx.locators.set(s.name, loc ?? { why: WHY.structure }); return; }
  }
  if (ctx.locators.has(root)) {
    const [loc, k] = pwLocator(links, 1, ctx.locators.get(root), ctx);
    if (k === links.length) { ctx.locators.set(s.name, loc ?? { why: WHY.structure }); return; }
  }
  // `const response = await page.goto(…)`: the action still happens.
  onChain(v.chain, at);
}

function pwStmt(s: Stmt, ctx: Ctx) {
  switch (s.kind) {
    case 'block': ctx.skip(where(s), WHY.block); return;
    case 'other': ctx.skip(where(s), WHY.code); return;
    case 'decl': decl(s, ctx, (c, at) => pwExpr(c, at, ctx)); return;
    case 'expr': pwExpr(s.chain, where(s), ctx); return;
  }
}

// ---------- Cypress ----------

const CY_NETWORK = new Set(['intercept', 'server', 'route', 'request', 'fixture', 'task', 'exec', 'readFile', 'writeFile', 'session', 'origin', 'clock', 'tick', 'setCookie', 'getCookie', 'getCookies', 'clearCookie', 'clearCookies', 'clearAllCookies', 'clearLocalStorage', 'clearAllLocalStorage', 'clearAllSessionStorage', 'window', 'document', 'stub', 'spy', 'wrap']);
const CY_STRUCTURE = new Set(['parent', 'parents', 'parentsUntil', 'closest', 'siblings', 'next', 'nextAll', 'nextUntil', 'prev', 'prevAll', 'prevUntil', 'children', 'not', 'filter', 'focused', 'root', 'shadow']);

/** Cypress typing: "hello{enter}" → "hello\n". Other {keys} can't be typed. */
function cyText(raw: string): { text: string } | { key: string } {
  let bad: string | undefined;
  const text = raw.replace(/\{([^}]*)\}/g, (_m, k: string) => {
    const key = k.toLowerCase();
    if (key === 'enter') return '\n';
    if (key === '{') return '{';
    bad ??= k;
    return '';
  });
  return bad !== undefined ? { key: bad } : { text };
}

function cyExpr(chain: Chain, s: Where, ctx: Ctx) {
  const links = chain.links;
  if (links[0].name === 'Cypress') { ctx.skip(s, WHY.settings, true); return; }
  if (links[0].name !== 'cy') { ctx.skip(s, links[0].args || links.length === 1 ? WHY.helper(links[0].name) : WHY.code); return; }
  let subject: (Loc | NoLoc | 'page' | undefined);
  const made = ctx.steps.length;
  for (let i = 1; i < links.length; i++) {
    const l = links[i], a = l.args ?? [];
    // A part of a chain that already made a step is listed on its own: ".clear()".
    const at: Where = made < ctx.steps.length && i > 1 ? { line: l.line, code: cut(l.src) } : s;
    const need = (fn: (loc: Loc) => void) => {
      if (subject === undefined || subject === 'page') { ctx.skip(at, WHY.structure); return; }
      if (!isLoc(subject)) { ctx.skip(at, subject.why); return; }
      if (!subject.name) { ctx.skip(at, WHICH); return; }
      fn(subject);
    };
    switch (l.name) {
      case 'visit': { const u = address(a[0]?.kind === 'obj' ? a[0].props.url : a[0], ctx); if (u) ctx.go(u.url, at, u.guessed); else ctx.skip(at, WHY.code); break; }
      case 'reload': ctx.add({ action: 'navigate', nav: 'reload' }, at); break;
      case 'go': {
        const d = str(a[0]);
        if (d === 'back' || d === '-1') ctx.add({ action: 'navigate', nav: 'back' }, at);
        else if (d === 'forward' || d === '1') ctx.add({ action: 'navigate', nav: 'forward' }, at);
        else ctx.skip(at, WHY.code);
        break;
      }
      case 'wait': {
        if (a[0]?.kind === 'num') ctx.add({ action: 'waitFor', seconds: Math.min(MAX_WAIT_S, Math.max(1, Math.ceil(a[0].v / 1000))) }, at);
        else ctx.skip(at, WHY.waits, true);
        break;
      }
      case 'viewport': {
        const w = a[0]?.kind === 'num' ? a[0].v : NaN, h = a[1]?.kind === 'num' ? a[1].v : NaN;
        if (w >= 200 && h >= 200) { ctx.viewport ??= { width: Math.round(w), height: Math.round(h) }; ctx.skip(at, WHY.viewport, true); }
        else ctx.skip(at, "Screen sizes by name aren't imported: pick the screen size when you create the test.", true);
        break;
      }
      case 'get': {
        const sel = str(a[0]);
        subject = sel === undefined ? { why: WHY.code } : sel.startsWith('@') ? { why: WHY.alias } : selectorLoc(sel);
        break;
      }
      case 'find': {
        const sel = str(a[0]);
        subject = sel === undefined ? { why: WHY.code } : selectorLoc(sel);
        break;
      }
      case 'contains': {
        // contains(text), contains(selector, text)
        const prevSubject = subject === 'page' ? undefined : subject;
        const textArg = a.length >= 2 && (a[1].kind === 'str' || a[1].kind === 'regex' || a[1].kind === 'num') ? a[1] : a[0];
        const text = shownText(textArg, ctx);
        if (text === undefined) { subject = { why: WHY.code }; break; }
        // contains('button', 'Sign in'): the "Sign in" button.
        const sel = textArg === a[1] ? str(a[0]) : undefined;
        const kind = sel ? selectorLoc(sel) : undefined;
        subject = kind && isLoc(kind) && kind.role && !kind.name ? { name: text, role: kind.role } : { name: text, text: true };
        // cy.get('h1').contains('Dashboard') the same way.
        if (!sel && subject.text && prevSubject && isLoc(prevSubject) && prevSubject.role && !prevSubject.name) subject = { name: text, role: prevSubject.role };
        break;
      }
      case 'first': if (subject && subject !== 'page' && isLoc(subject)) subject = { ...subject, ordinal: 1 }; break;
      case 'last': if (subject && subject !== 'page' && isLoc(subject)) subject = { ...subject, ordinal: -1 }; break;
      case 'eq': {
        const n = a[0]?.kind === 'num' ? a[0].v : NaN;
        if (subject && subject !== 'page' && isLoc(subject)) subject = Number.isInteger(n) && n >= -1 && n < 10 ? { ...subject, ordinal: n === -1 ? -1 : n + 1 } : { ...subject, guessed: true };
        break;
      }
      case 'url': case 'title': case 'location': case 'hash': subject = 'page'; break;
      case 'click': case 'dblclick': case 'rightclick': need(loc => {
        const action = l.name === 'dblclick' ? 'doubleClick' : l.name === 'rightclick' ? 'rightClick' : 'click';
        ctx.add({ action, target: targetWords(loc) }, at, { guessed: loc.guessed });
      }); break;
      case 'check': case 'uncheck': need(loc => { const t = forAction(loc, 'check'); ctx.add({ action: 'click', target: targetWords(t) }, at, { guessed: t.guessed }); }); break;
      case 'type': need(loc => {
        const t = typed(a[0], ctx);
        const field = forAction(loc.role ? loc : { ...loc, label: true }, 'write');
        if (!('text' in t)) { writeStep(ctx, at, field, t); return; }
        const c = cyText(t.text);
        if ('key' in c) { ctx.skip(at, WHY.special(c.key)); return; }
        if (c.text === '') return;
        writeStep(ctx, at, field, { text: c.text, ...(t.guessed ? { guessed: true } : {}) });
      }); break;
      case 'clear': ctx.skip(at, WHY.clear); break;
      case 'select': need(loc => selectSteps(ctx, at, loc, a[0])); break;
      case 'trigger': {
        const ev = str(a[0]);
        if (ev === 'mouseover' || ev === 'mouseenter') need(loc => ctx.add({ action: 'hover', target: targetWords(loc) }, at, { guessed: loc.guessed }));
        else ctx.skip(at, WHY.code);
        break;
      }
      case 'realHover': need(loc => ctx.add({ action: 'hover', target: targetWords(loc) }, at, { guessed: loc.guessed })); break;
      case 'should': case 'and': {
        const chainer = str(a[0]);
        if (subject === 'page') { ctx.skip(at, WHY.address); break; }
        if (!chainer) { ctx.skip(at, WHY.code); break; }
        if (chainer.startsWith('not.')) { ctx.skip(at, WHY.absent); break; }
        if (chainer === 'be.visible' || chainer === 'exist' || chainer === 'be.exist') {
          need(loc => ctx.add({ action: 'checkpoint', target: targetWords(loc) }, at, { guessed: loc.guessed }));
          break;
        }
        if (['contain', 'contain.text', 'have.text', 'include.text', 'contains'].includes(chainer)) {
          const text = shownText(a[1], ctx);
          if (text === undefined) { ctx.skip(at, WHY.code); break; }
          const kind = subject && isLoc(subject) && subject.role && !subject.name ? subject.role : undefined;
          ctx.add({ action: 'checkpoint', target: targetWords(kind ? { name: text, role: kind } : { name: text, text: true }) }, at);
          break;
        }
        ctx.skip(at, WHY.pageCode(chainer.replace(/\./g, ' ')));
        break;
      }
      case 'focus': case 'blur': ctx.skip(at, WHY.focus, true); break;
      case 'scrollIntoView': case 'scrollTo': ctx.skip(at, WHY.scroll); break;
      case 'selectFile': case 'attachFile': ctx.skip(at, WHY.upload); break;
      case 'log': ctx.skip(at, WHY.log, true); break;
      case 'screenshot': case 'matchImageSnapshot': ctx.skip(at, WHY.screenshot, true); break;
      case 'as': break;
      case 'within': case 'then': case 'each': ctx.skip(at, WHY.callback); return;
      case 'invoke': case 'its': case 'spread': ctx.skip(at, WHY.code); return;
      default:
        if (CY_NETWORK.has(l.name)) { ctx.skip(at, WHY.network); return; }
        if (CY_STRUCTURE.has(l.name)) { subject = { why: WHY.structure }; break; }
        if (l.name === 'submit') { ctx.skip(at, WHY.code); break; }
        ctx.skip(at, i === 1 ? WHY.custom(l.name) : WHY.code);
        return;
    }
  }
}

function cyStmt(s: Stmt, ctx: Ctx) {
  switch (s.kind) {
    case 'block': ctx.skip(where(s), WHY.block); return;
    case 'other': ctx.skip(where(s), WHY.code); return;
    case 'decl': decl(s, ctx, (c, at) => cyExpr(c, at, ctx)); return;
    case 'expr': cyExpr(s.chain, where(s), ctx); return;
  }
}

// ---------- Tests, describe blocks and hooks ----------

/** `setup`: declarations around the test (its file's and describe blocks' consts), read first without being listed. */
interface Found { name: string; body: Stmt[]; befores: Stmt[]; setup: Stmt[]; viewport?: { width: number; height: number } }
const TEST_WORDS = new Set(['test', 'it', 'specify']);
const MODIFIERS = new Set(['only', 'skip', 'fixme', 'fail', 'slow', 'concurrent', 'serial', 'parallel', 'todo']);
const DESCRIBE_WORDS = new Set(['describe', 'context', 'suite']);
const HOOKS = new Set(['beforeEach', 'beforeAll', 'before']);

type Kind = 'test' | 'describe' | 'hook' | 'use' | null;
function kindOf(c: Chain): Kind {
  const names = c.links.map(l => l.name);
  const [first, second] = names;
  const mods = (from: number) => names.slice(from).every(n => MODIFIERS.has(n));
  if (first === 'test' && second === 'describe' && mods(2)) return 'describe';
  if (DESCRIBE_WORDS.has(first) && mods(1)) return 'describe';
  if (first === 'test' && second && HOOKS.has(second) && names.length === 2) return 'hook';
  if (HOOKS.has(first) && names.length === 1) return 'hook';
  if (first === 'test' && second === 'use') return 'use';
  if (TEST_WORDS.has(first) && mods(1)) return 'test';
  return null;
}
const lastArgs = (c: Chain) => c.links[c.links.length - 1].args ?? [];
const fnOf = (c: Chain) => { const f = lastArgs(c).filter(a => a.kind === 'fn').pop(); return f?.kind === 'fn' ? f.body : undefined; };

function collect(stmts: Stmt[], befores: Stmt[], setup: Stmt[], viewport: Found['viewport'], out: Found[]) {
  // Hooks and test.use() apply to every test at this level, wherever they're written.
  const here = [...befores], decls = [...setup, ...stmts.filter(s => s.kind === 'decl')];
  let vp = viewport;
  for (const s of stmts) {
    if (s.kind !== 'expr') continue;
    const k = kindOf(s.chain);
    if (k === 'hook') here.push(...(fnOf(s.chain) ?? []));
    if (k === 'use') { const o = lastArgs(s.chain)[0]; if (o?.kind === 'obj' && o.props.viewport?.kind === 'obj') vp = sizeOf(o.props.viewport) ?? vp; }
  }
  for (const s of stmts) {
    if (s.kind !== 'expr') continue;
    const k = kindOf(s.chain);
    const body = fnOf(s.chain);
    if (k === 'describe' && body) collect(body, here, decls, vp, out);
    else if (k === 'test' && body) out.push({ name: str(lastArgs(s.chain)[0])?.trim() || 'Imported test', body, befores: here, setup: decls, ...(vp ? { viewport: vp } : {}) });
  }
}

/** "checkout-flow.spec.ts" → "Checkout flow". */
export function nameFromFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const words = idWords(base.replace(/(\.(spec|test|cy|e2e))?\.[cm]?[jt]sx?$/i, '')).trim();
  return words ? words[0].toUpperCase() + words.slice(1) : 'Imported test';
}

/** Is this a Cypress script? Its file name says so, or it uses `cy.` and not `page.`. */
export function frameworkOf(p: Parser, fileName: string): Framework {
  if (/\.cy\.[cm]?[jt]sx?$/i.test(fileName)) return 'cypress';
  let cy = 0, page = 0;
  for (let i = 0; i + 1 < p.t.length; i++) {
    if (p.t[i].kind === 'id' && p.is(i + 1, '.') && !p.is(i - 1, '.')) {
      if (p.t[i].value === 'cy') cy++;
      else if (p.t[i].value === 'page') page++;
    }
  }
  return cy > page ? 'cypress' : 'playwright';
}

/**
 * The tests in a Playwright or Cypress script, each with its steps and the lines that aren't
 * steps. A file with no test() or it() blocks (Playwright codegen's library output, a plain
 * script) is read as one test: the code around its first `page.` or `cy.` line.
 */
export function importScript(source: string, fileName = ''): ScriptImport {
  const p = new Parser(source);
  const framework = frameworkOf(p, fileName);
  const found: Found[] = [];
  collect(p.statements(0, p.t.length), [], [], undefined, found);
  if (!found.length) {
    const body = scriptBody(p, framework === 'cypress' ? 'cy' : 'page');
    if (body) found.push({ name: '', body, befores: [], setup: [] });
  }
  const read = framework === 'cypress' ? cyStmt : pwStmt;
  const tests = found.map(f => {
    const ctx = new Ctx();
    ctx.quiet = true;
    for (const s of f.setup) read(s, ctx);
    ctx.quiet = false;
    for (const s of [...f.befores, ...f.body]) read(s, ctx);
    const name = !f.name || (f.name === 'test' && fileName) ? nameFromFile(fileName) : f.name;
    const viewport = ctx.viewport ?? f.viewport;
    return { name, ...(ctx.startUrl !== undefined ? { startUrl: ctx.startUrl } : {}), ...(viewport ? { viewport } : {}), steps: ctx.steps, skipped: ctx.skipped };
  });
  return { framework, tests };
}

/** The statements of the block around the first `page.` (or `cy.`) line: the script's own steps. */
function scriptBody(p: Parser, root: string): Stmt[] | null {
  const first = p.t.findIndex((k, i) => k.kind === 'id' && k.value === root && p.is(i + 1, '.') && !p.is(i - 1, '.'));
  if (first < 0) return null;
  let depth = 0;
  for (let k = first - 1; k >= 0; k--) {
    if (p.is(k, '}')) depth++;
    else if (p.is(k, '{')) { if (depth === 0) return p.statements(k + 1, p.close(k)); depth--; }
  }
  return p.statements(0, p.t.length).filter(s => !(s.kind === 'other' && /^(import|export)\b/.test(s.src)) && !(s.kind === 'decl' && /require\(/.test(s.src)));
}

/**
 * The steps' addresses made full against `base` (the app's address): "/login" →
 * "https://app.example.com/login". A Go to step to anything but a web address (`file:`,
 * `javascript:`…) is left out and listed: the test browser only opens http and https.
 */
export function withBase(t: ImportedTest, base: string): ImportedTest {
  const full = (u: string) => { try { return new URL(u, base).href; } catch { return u; } };
  const web = (u: string) => /^https?:\/\//i.test(u);
  const steps: ImportStep[] = [], skipped = [...t.skipped];
  for (const s of t.steps) {
    if (s.action !== 'navigate' || !s.url) { steps.push(s); continue; }
    const url = full(s.url);
    if (web(url)) steps.push({ ...s, url });
    else skipped.push({ line: s.line, code: s.code, why: WHY.notWeb });
  }
  skipped.sort((a, b) => a.line - b.line);
  return { ...t, ...(t.startUrl !== undefined ? { startUrl: full(t.startUrl) } : {}), steps, skipped };
}

/**
 * The steps to learn: a value the script reads from the environment becomes the saved secret of
 * that name when this Mac has one (`PASSWORD`, `TEST_PASSWORD`, any case); otherwise the step asks.
 */
export function withSecrets(steps: ImportStep[], secretNames: string[]): ImportStep[] {
  const byKey = new Map(secretNames.map(n => [n.toUpperCase().replace(/[^A-Z0-9]/g, '_'), n]));
  return steps.map(s => {
    if (!s.secretHint || s.secretRef) return s;
    const name = byKey.get(s.secretHint.toUpperCase().replace(/[^A-Z0-9]/g, '_'));
    if (!name) return s;
    const { needs: _n, ...rest } = s;
    return { ...rest, secretRef: name };
  });
}

// ---------- For the Import dialog ----------

/** The script files the picker offers. */
export const SCRIPT_EXTENSIONS = ['ts', 'js', 'mjs', 'cjs', 'mts', 'cts', 'tsx', 'jsx'];
/** A test script is a few KB: anything this big isn't one. */
export const MAX_SCRIPT_BYTES = 2_000_000;
export const NOTHING_FOUND = "Breakpatch didn't find a Playwright or Cypress test in this script. It reads test() and it() blocks, or a script that uses page or cy.";

/** A step as the recorder learns it: without where it came from; a guessed one asks before it's done (`check`). */
export function toWalk(s: ImportStep): WalkStep {
  const { line: _l, code: _c, guessed, secretHint: _s, note: _n, ...w } = s;
  return guessed ? { ...w, check: true } : w;
}

/** "3 lines of the script weren't imported." for the recorder's card, or nothing. */
export function leftOutNote(t: ImportedTest): string | undefined {
  const n = new Set(t.skipped.filter(s => !s.notNeeded).map(s => s.line)).size;
  return n ? `${n === 1 ? 'One line' : `${n} lines`} of the script ${n === 1 ? "wasn't" : "weren't"} imported.` : undefined;
}

// Reads statements, call chains and literal values from a test script's tokens (tokens.ts), for
// importing Playwright and Cypress tests (roadmap #16). Only the shapes tests use are understood:
// `await page.getByRole('button', { name: 'Save' }).click()`, `cy.get('#email').type('a@b.c')`,
// `const x = 'text'`, `expect(…).toBeVisible()`, and the test(), describe() and hook calls around
// them. Anything else is kept as "other" with its text, so it can be listed, never guessed at.
import { tokenize, type Token } from './tokens';

/** A value as written in the script, when it can be read without running anything. */
export type Value =
  | { kind: 'str'; v: string }
  | { kind: 'num'; v: number }
  | { kind: 'bool'; v: boolean }
  | { kind: 'regex'; source: string; flags: string }
  | { kind: 'obj'; props: Record<string, Value> }
  | { kind: 'arr'; items: Value[] }
  /** Names and calls: `process.env.PASSWORD`, `page.getByRole(…)`; `awaited`: written after `await`. */
  | { kind: 'chain'; chain: Chain; awaited?: boolean }
  /** A function: its body's statements (an arrow function with an expression body has one). */
  | { kind: 'fn'; body: Stmt[] }
  /** A template literal with `${…}` parts: its raw text between the backticks. */
  | { kind: 'tmpl'; raw: string }
  /** Anything else (arithmetic, `new …`, `a ?? b`): its source text. */
  | { kind: 'other'; text: string };

/** One link of a chain: `.click()`, `getByRole('button', …)`, `.not`. `args` is unset for a plain name. */
export interface Link { name: string; args?: Value[]; line: number; /** Its source: ".click()" */ src: string }
/** `page.getByText('Hi').click()`: [page, getByText(…), click()]. The first link is the root name. */
export interface Chain { links: Link[] }

export type Stmt =
  | { kind: 'expr'; chain: Chain; line: number; endLine: number; src: string }
  /** `const a = …`: `name` is unset for a destructuring pattern. */
  | { kind: 'decl'; name?: string; init?: Value; line: number; endLine: number; src: string }
  /** if, for, while, try, switch…: never imported. */
  | { kind: 'block'; keyword: string; line: number; endLine: number; src: string }
  | { kind: 'other'; line: number; endLine: number; src: string };

const BLOCK_WORDS = new Set(['if', 'for', 'while', 'do', 'switch', 'try', 'with']);
const DECL_WORDS = new Set(['const', 'let', 'var']);
/** Tokens that close a value in a list or a statement. */
const CLOSERS = new Set([',', ')', ']', '}', ';', ':']);
/** Punctuation that, ending a line, carries the expression on to the next one. */
const CARRIES = new Set(['.', '?.', '(', '[', '{', ',', '=', '=>', '+', '-', '*', '/', '%', '&&', '||', '??', '?', ':', '==', '===', '!=', '!==', '<', '>', '<=', '>=', '!', '+=', '-=']);

export class Parser {
  readonly t: Token[];
  readonly src: string;
  constructor(src: string) { this.src = src; this.t = tokenize(src); }

  /** The source text from token `a` to token `b` (inclusive), on one line. */
  text(a: number, b: number): string {
    if (a > b || !this.t[a]) return '';
    return this.src.slice(this.t[a].start, this.t[Math.min(b, this.t.length - 1)].end).replace(/\s*\n\s*/g, ' ').trim();
  }
  is(i: number, value: string): boolean { const k = this.t[i]; return !!k && k.kind === 'punct' && k.value === value; }
  isWord(i: number, value?: string): boolean { const k = this.t[i]; return !!k && k.kind === 'id' && (value === undefined || k.value === value); }

  /** The index of the bracket that closes the one at `i` (`(`, `[` or `{`), or the last token. */
  close(i: number): number {
    let depth = 0;
    for (let k = i; k < this.t.length; k++) {
      const v = this.t[k];
      if (v.kind !== 'punct') continue;
      if (v.value === '(' || v.value === '[' || v.value === '{') depth++;
      else if (v.value === ')' || v.value === ']' || v.value === '}') { depth--; if (depth === 0) return k; }
    }
    return this.t.length - 1;
  }

  /** The statements from token `from` up to (not including) `to`. */
  statements(from: number, to: number): Stmt[] {
    const out: Stmt[] = [];
    let i = from;
    while (i < to) {
      if (this.is(i, ';')) { i++; continue; }
      const [stmt, next] = this.statement(i, to);
      if (stmt) out.push(stmt);
      i = Math.max(next, i + 1);
    }
    return out;
  }

  /** Tokens `a` to `b` as a statement that isn't imported. */
  private other(a: number, b: number): Stmt {
    return { kind: 'other', line: this.t[a].line, endLine: this.t[Math.min(b, this.t.length - 1)].line, src: this.text(a, b) };
  }

  /** One statement starting at `i`: it and the index after it. */
  statement(i: number, to: number): [Stmt | null, number] {
    const k = this.t[i];
    if (k.kind === 'punct' && k.value === '{') { const c = this.close(i); return [{ kind: 'block', keyword: '{', line: k.line, endLine: this.t[c].line, src: this.text(i, c) }, c + 1]; }
    if (k.kind === 'id' && BLOCK_WORDS.has(k.value)) {
      const end = this.blockEnd(i, to);
      return [{ kind: 'block', keyword: k.value, line: k.line, endLine: this.t[end - 1].line, src: this.text(i, end - 1) }, end];
    }
    if (k.kind === 'id' && (k.value === 'import' || k.value === 'export') && !this.is(i + 1, '(') && !this.is(i + 1, '.')) {
      // `export const …` is the declaration; other imports and exports aren't steps.
      if (k.value === 'export' && this.isWord(i + 1) && (DECL_WORDS.has(this.t[i + 1].value) || this.t[i + 1].value === 'async' || this.t[i + 1].value === 'function')) return this.statement(i + 1, to);
      const end = this.statementEnd(i + 1, to);
      return [this.other(i, end - 1), end];
    }
    if (k.kind === 'id' && (k.value === 'function' || k.value === 'async' && this.isWord(i + 1, 'function') || k.value === 'class' || k.value === 'interface' || k.value === 'type' && this.isWord(i + 1) || k.value === 'enum')) {
      // A declaration with a body: up to its closing brace.
      let b = i; while (b < to && !this.is(b, '{')) b++;
      if (k.value === 'type') { const end = this.statementEnd(i + 1, to); return [this.other(i, end - 1), end]; }
      const c = b < to ? this.close(b) : to - 1;
      return [this.other(i, c), c + 1];
    }
    if (k.kind === 'id' && DECL_WORDS.has(k.value)) {
      let j = i + 1, name: string | undefined;
      if (this.isWord(j)) { name = this.t[j].value; j++; }
      else if (this.is(j, '{') || this.is(j, '[')) j = this.close(j) + 1;
      // A type annotation, up to `=` at this level.
      if (this.is(j, ':') || this.is(j, '!')) {
        let depth = 0;
        for (; j < to; j++) {
          const v = this.t[j];
          if (v.kind === 'punct' && (v.value === '(' || v.value === '[' || v.value === '{' || v.value === '<')) depth++;
          else if (v.kind === 'punct' && (v.value === ')' || v.value === ']' || v.value === '}' || v.value === '>')) depth--;
          else if (depth <= 0 && v.kind === 'punct' && (v.value === '=' || v.value === ';')) break;
          if (depth <= 0 && j > i + 2 && v.nl && !CARRIES.has(this.t[j - 1].value)) break;
        }
      }
      let init: Value | undefined;
      if (this.is(j, '=')) { const [v, n] = this.value(j + 1, to); init = v; j = n; }
      const end = this.statementEnd(j, to);
      // `const a = 1, b = 2`: one statement, read as the first.
      return [{ kind: 'decl', ...(name ? { name } : {}), ...(init ? { init } : {}), line: k.line, endLine: this.t[end - 1].line, src: this.text(i, end - 1) }, end];
    }
    // An expression statement.
    let j = i;
    if (this.isWord(j, 'await') || this.isWord(j, 'return') || this.isWord(j, 'void')) j++;
    const [v, n] = this.value(j, to);
    const end = this.statementEnd(n, to);
    if (v.kind === 'chain' && end === this.afterValue(n, to)) {
      return [{ kind: 'expr', chain: v.chain, line: k.line, endLine: this.t[end - 1].line, src: this.text(i, end - 1) }, end];
    }
    return [this.other(i, end - 1), end];
  }

  /** Just past a value that ended at `n`: past a `;`. */
  private afterValue(n: number, to: number): number { return n < to && this.is(n, ';') ? n + 1 : n; }

  /** Where the statement whose last value ended at `j` stops: after its `;`, or at a new line that starts another. */
  statementEnd(j: number, to: number): number {
    let depth = 0;
    for (let k = j; k < to; k++) {
      const v = this.t[k];
      if (depth === 0 && k > 0 && v.nl && !CARRIES.has(v.value) && !CARRIES.has(this.t[k - 1].value)) return k;
      if (v.kind !== 'punct') continue;
      if (v.value === '(' || v.value === '[' || v.value === '{') depth++;
      else if (v.value === ')' || v.value === ']' || v.value === '}') { if (depth === 0) return k; depth--; }
      else if (v.value === ';' && depth === 0) return k + 1;
    }
    return to;
  }

  /** The end (exclusive) of an if/for/while/try… statement at `i`, with its else, catch and finally. */
  private blockEnd(i: number, to: number): number {
    let j = i + 1;
    const word = this.t[i].value;
    if (word === 'do') {
      j = this.bodyEnd(j, to);
      if (this.isWord(j, 'while') && this.is(j + 1, '(')) j = this.close(j + 1) + 1;
      return this.is(j, ';') ? j + 1 : j;
    }
    if (word === 'for' && this.isWord(j, 'await')) j++;
    if (this.is(j, '(')) j = this.close(j) + 1;
    j = this.bodyEnd(j, to);
    for (;;) {
      if (this.isWord(j, 'else')) { j = this.isWord(j + 1, 'if') ? this.blockEnd(j + 1, to) : this.bodyEnd(j + 1, to); continue; }
      if (this.isWord(j, 'catch')) { j++; if (this.is(j, '(')) j = this.close(j) + 1; j = this.bodyEnd(j, to); continue; }
      if (this.isWord(j, 'finally')) { j = this.bodyEnd(j + 1, to); continue; }
      return j;
    }
  }
  private bodyEnd(j: number, to: number): number {
    if (this.is(j, '{')) return this.close(j) + 1;
    if (j >= to) return to;
    const [, n] = this.statement(j, to);
    return n;
  }

  /** A value starting at `i`: it, and the index after it. Stops before `,`, `)`, `]`, `}`, `;`. */
  value(i: number, to: number): [Value, number] {
    const start = i;
    const [v, n] = this.primary(i, to);
    // An operator after it (`a + b`, `x ?? 'y'`, `a as T`): the whole thing is "other".
    let j = n, depth = 0;
    for (; j < to; j++) {
      const k = this.t[j];
      if (depth === 0 && k.kind === 'punct' && CLOSERS.has(k.value) && !(k.value === ':' && this.ternary(start, j))) break;
      if (depth === 0 && k.nl && !CARRIES.has(k.value) && !CARRIES.has(this.t[j - 1].value)) break;
      if (k.kind === 'punct' && (k.value === '(' || k.value === '[' || k.value === '{')) depth++;
      else if (k.kind === 'punct' && (k.value === ')' || k.value === ']' || k.value === '}')) { if (depth === 0) break; depth--; }
    }
    if (j === n) return [v, n];
    // `x as const`, `x!`: the value itself.
    if (this.isWord(n, 'as') || this.isWord(n, 'satisfies') || (this.is(n, '!') && j === n + 1)) return [v, j];
    return [{ kind: 'other', text: this.text(start, j - 1) }, j];
  }
  /** A `:` at `j` belongs to a `?` before it, in the value from `start`. */
  private ternary(start: number, j: number): boolean {
    let q = 0;
    for (let k = start; k < j; k++) if (this.is(k, '?')) q++; else if (this.is(k, ':')) q--;
    return q > 0;
  }

  private primary(i: number, to: number): [Value, number] {
    const k = this.t[i];
    if (!k || i >= to) return [{ kind: 'other', text: '' }, i];
    if (k.kind === 'str') return [{ kind: 'str', v: k.value }, i + 1];
    if (k.kind === 'tmpl') return [k.dynamic ? { kind: 'tmpl', raw: k.value } : { kind: 'str', v: k.value }, i + 1];
    if (k.kind === 'num') return [{ kind: 'num', v: Number(k.value) }, i + 1];
    if (k.kind === 'regex') return [{ kind: 'regex', source: k.value, flags: k.flags ?? '' }, i + 1];
    if (k.kind === 'punct' && k.value === '-' && this.t[i + 1]?.kind === 'num') return [{ kind: 'num', v: -Number(this.t[i + 1].value) }, i + 2];
    if (k.kind === 'punct' && k.value === '{') return this.object(i);
    if (k.kind === 'punct' && k.value === '[') {
      const c = this.close(i), items: Value[] = [];
      let j = i + 1;
      while (j < c) {
        if (this.is(j, ',')) { j++; continue; }
        const [v, n] = this.value(j, c); items.push(v); j = Math.max(n, j + 1);
      }
      return [{ kind: 'arr', items }, c + 1];
    }
    // Functions: `async ({ page }) => { … }`, `() => …`, `function () { … }`, `x => …`.
    let j = i;
    if (this.isWord(j, 'async') && !this.is(j + 1, '(') || this.isWord(j, 'async') && this.arrowAfterParens(j + 1)) j++;
    if (this.isWord(j, 'function')) {
      let b = j; while (b < to && !this.is(b, '{')) b++;
      const c = b < to ? this.close(b) : to - 1;
      return [{ kind: 'fn', body: this.statements(b + 1, c) }, c + 1];
    }
    if (this.is(j, '(') && this.arrowAfterParens(j)) return this.arrow(this.arrowAt(j), to);
    if (this.isWord(j) && this.is(j + 1, '=>')) return this.arrow(j + 1, to);
    if (k.kind === 'punct' && k.value === '(') {
      // `(expr)`: the value inside, when there's only one.
      const c = this.close(i);
      const [v, n] = this.value(i + 1, c);
      return [n === c ? v : { kind: 'other', text: this.text(i, c) }, c + 1];
    }
    if (k.kind === 'id' && ['true', 'false'].includes(k.value)) return [{ kind: 'bool', v: k.value === 'true' }, i + 1];
    if (k.kind === 'id' && k.value === 'await' && this.isWord(i + 1)) {
      const [v, n] = this.primary(i + 1, to);
      return [v.kind === 'chain' ? { ...v, awaited: true } : v, n];
    }
    if (k.kind === 'id' && k.value !== 'new' && k.value !== 'typeof') {
      const [chain, n] = this.chain(i, to);
      return [{ kind: 'chain', chain }, n];
    }
    return [{ kind: 'other', text: k.value }, i + 1];
  }

  /** `(…)` at `j` is an arrow function's parameters: `=>` comes after them (maybe after a return type). */
  private arrowAfterParens(j: number): boolean { return this.is(j, '(') && this.arrowAt(j) > 0; }
  /** The index of the `=>` after the parameters at `j`, or -1. */
  private arrowAt(j: number): number {
    let k = this.close(j) + 1;
    if (this.is(k, ':')) {           // a return type: `(): Promise<void> =>`
      let depth = 0;
      for (k = k + 1; k < this.t.length; k++) {
        if (this.is(k, '<') || this.is(k, '(') || this.is(k, '{') || this.is(k, '[')) depth++;
        else if (this.is(k, '>') || this.is(k, ')') || this.is(k, '}') || this.is(k, ']')) depth--;
        else if (depth <= 0 && this.is(k, '=>')) break;
        if (this.is(k, ';')) return -1;
      }
    }
    return this.is(k, '=>') ? k : -1;
  }
  private arrow(arrowIdx: number, to: number): [Value, number] {
    const b = arrowIdx + 1;
    if (this.is(b, '{')) { const c = this.close(b); return [{ kind: 'fn', body: this.statements(b + 1, c) }, c + 1]; }
    const [v, n] = this.value(b, to);
    const body: Stmt[] = v.kind === 'chain' ? [{ kind: 'expr', chain: v.chain, line: this.t[b].line, endLine: this.t[Math.max(b, n - 1)].line, src: this.text(b, n - 1) }] : [];
    return [{ kind: 'fn', body }, n];
  }

  private object(i: number): [Value, number] {
    const c = this.close(i), props: Record<string, Value> = {};
    let j = i + 1;
    while (j < c) {
      if (this.is(j, ',')) { j++; continue; }
      const k = this.t[j];
      if ((k.kind === 'id' || k.kind === 'str' || k.kind === 'num') && this.is(j + 1, ':')) {
        const [v, n] = this.value(j + 2, c); props[k.value] = v; j = Math.max(n, j + 1); continue;
      }
      if (k.kind === 'id' && (this.is(j + 1, ',') || j + 1 === c)) { props[k.value] = { kind: 'chain', chain: { links: [{ name: k.value, line: k.line, src: k.value }] } }; j++; continue; }
      // A spread, a method or a computed key: skip to the next comma.
      let depth = 0;
      for (; j < c; j++) {
        if (this.is(j, '(') || this.is(j, '[') || this.is(j, '{')) depth++;
        else if (this.is(j, ')') || this.is(j, ']') || this.is(j, '}')) depth--;
        else if (depth === 0 && this.is(j, ',')) break;
      }
    }
    return [{ kind: 'obj', props }, c + 1];
  }

  /** A chain of names and calls from `i`: `cy.get('#a')\n  .type('x')` is one chain. */
  chain(i: number, to: number): [Chain, number] {
    const first = this.t[i];
    const links: Link[] = [{ name: first.value, line: first.line, src: first.value }];
    let j = i + 1, linkStart = i;
    while (j < to) {
      const k = this.t[j];
      if (k.kind !== 'punct') break;
      if ((k.value === '.' || k.value === '?.') && this.isWord(j + 1)) {
        linkStart = j;
        links.push({ name: this.t[j + 1].value, line: this.t[j + 1].line, src: this.text(j, j + 1) });
        j += 2; continue;
      }
      if (k.value === '?.' && this.is(j + 1, '(')) { j++; continue; }
      // A call: on the same line as what it calls (a `(` starting a line starts something else).
      if (k.value === '(' && !k.nl) {
        const c = this.close(j), args: Value[] = [];
        let a = j + 1;
        while (a < c) {
          if (this.is(a, ',')) { a++; continue; }
          const [v, n] = this.value(a, c); args.push(v); a = Math.max(n, a + 1);
        }
        const last = links[links.length - 1];
        if (last.args) links.push({ name: '', args, line: k.line, src: this.text(j, c) });
        else { last.args = args; last.src = this.text(linkStart, c); }
        j = c + 1; continue;
      }
      // TypeScript's non-null `!` before a `.` or a call.
      if (k.value === '!' && (this.is(j + 1, '.') || this.is(j + 1, '(') || this.is(j + 1, ')'))) { j++; continue; }
      if (k.value === '[' && !k.nl) {
        const c = this.close(j);
        links.push({ name: '[]', line: k.line, src: this.text(j, c) });
        j = c + 1; continue;
      }
      break;
    }
    return [{ links }, j];
  }
}

/** The text of a value that is a plain string (or a number), else undefined. */
export function str(v: Value | undefined): string | undefined {
  if (!v) return undefined;
  if (v.kind === 'str') return v.v;
  if (v.kind === 'num') return String(v.v);
  return undefined;
}

/** `a.b.c` for a chain of plain names, else undefined. */
export function dotted(c: Chain): string | undefined {
  return c.links.every(l => !l.args && l.name && l.name !== '[]') ? c.links.map(l => l.name).join('.') : undefined;
}

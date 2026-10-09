// A small JavaScript and TypeScript tokenizer for importing test scripts (roadmap #16). The script
// is only read, never run: this turns its text into words, strings, numbers, regular expressions
// and punctuation, with the line each starts on, and parse.ts reads the common patterns from them.
// It doesn't need to understand all of JavaScript, only to never be fooled into reading a string,
// a comment or a regular expression as code.

export type TokenKind = 'id' | 'str' | 'tmpl' | 'num' | 'regex' | 'punct';

export interface Token {
  kind: TokenKind;
  /** The text (punctuation, a word), a string's value with its escapes worked out, a regex's source. */
  value: string;
  /** 1-based line the token starts on. */
  line: number;
  /** A line break comes before it (for statements that end without a semicolon). */
  nl: boolean;
  /** Where it is in the source: [start, end). */
  start: number; end: number;
  /** A template literal with `${…}` in it: its value is only known when the script runs. */
  dynamic?: boolean;
  /** A regex's flags. */
  flags?: string;
}

const PUNCT = ['>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>'];
/** After these words a `/` starts a regular expression, not a division. */
const BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'throw', 'await', 'yield', 'else', 'do']);

const isIdStart = (c: string) => /[A-Za-z_$À-￿]/.test(c);
const isId = (c: string) => /[\w$À-￿]/.test(c);

/** The value of an escape at `i` (just after the backslash) and where it ends. */
function escape(src: string, i: number): [string, number] {
  const c = src[i];
  switch (c) {
    case 'n': return ['\n', i + 1];
    case 'r': return ['\r', i + 1];
    case 't': return ['\t', i + 1];
    case 'b': return ['\b', i + 1];
    case 'f': return ['\f', i + 1];
    case 'v': return ['\v', i + 1];
    case '0': return ['\0', i + 1];
    case '\r': return ['', src[i + 1] === '\n' ? i + 2 : i + 1];
    case '\n': return ['', i + 1];
    case 'x': {
      const h = src.slice(i + 1, i + 3);
      return /^[0-9a-f]{2}$/i.test(h) ? [String.fromCharCode(parseInt(h, 16)), i + 3] : ['x', i + 1];
    }
    case 'u': {
      if (src[i + 1] === '{') {
        const close = src.indexOf('}', i + 2);
        const h = close > 0 ? src.slice(i + 2, close) : '';
        if (/^[0-9a-f]{1,6}$/i.test(h) && parseInt(h, 16) <= 0x10ffff) return [String.fromCodePoint(parseInt(h, 16)), close + 1];
        return ['u', i + 1];
      }
      const h = src.slice(i + 1, i + 5);
      return /^[0-9a-f]{4}$/i.test(h) ? [String.fromCharCode(parseInt(h, 16)), i + 5] : ['u', i + 1];
    }
    default: return [c ?? '', i + 1];
  }
}

/**
 * The tokens of `src`. Never throws: an unfinished string or comment runs to the end of the text
 * (the parser then finds less in it).
 */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0, line = 1, nl = false;
  const push = (t: Omit<Token, 'line' | 'nl'>, startLine: number) => { out.push({ ...t, line: startLine, nl }); nl = false; };
  const countLines = (from: number, to: number) => { for (let k = from; k < to; k++) if (src[k] === '\n') line++; };

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; nl = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === ' ' || c === '﻿' || c === ' ' || c === ' ') { i++; continue; }
    // Comments.
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const to = close < 0 ? src.length : close + 2;
      const before = line; countLines(i, to); if (line !== before) nl = true;
      i = to; continue;
    }
    const startLine = line, start = i;
    // Strings.
    if (c === '"' || c === "'") {
      let v = ''; i++;
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') { const [e, n] = escape(src, i + 1); countLines(i, n); v += e; i = n; } else v += src[i++];
      }
      if (src[i] === c) i++;
      push({ kind: 'str', value: v, start, end: i }, startLine);
      continue;
    }
    // Template literals: the text, and whether it has `${…}` parts.
    if (c === '`') {
      let v = '', dynamic = false; i++;
      while (i < src.length && src[i] !== '`') {
        if (src[i] === '\\') { const [e, n] = escape(src, i + 1); countLines(i, n); v += e; i = n; continue; }
        if (src[i] === '$' && src[i + 1] === '{') {
          dynamic = true;
          // Up to the matching brace, stepping over strings inside it.
          let depth = 0, k = i + 1;
          for (; k < src.length; k++) {
            const ch = src[k];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) break; }
            else if (ch === '"' || ch === "'" || ch === '`') {
              const q = ch; k++;
              while (k < src.length && src[k] !== q) { if (src[k] === '\\') k++; k++; }
            }
          }
          countLines(i, k);
          v += src.slice(i, k + 1);
          i = k + 1; continue;
        }
        if (src[i] === '\n') line++;
        v += src[i++];
      }
      if (src[i] === '`') i++;
      push({ kind: 'tmpl', value: v, start, end: i, ...(dynamic ? { dynamic } : {}) }, startLine);
      continue;
    }
    // Numbers.
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      while (i < src.length && /[\w.]/.test(src[i])) {
        // 1e-3, 1E+3
        if ((src[i] === 'e' || src[i] === 'E') && (src[i + 1] === '-' || src[i + 1] === '+') && !/^0x/i.test(src.slice(start, i))) i++;
        i++;
      }
      push({ kind: 'num', value: src.slice(start, i).replace(/_/g, ''), start, end: i }, startLine);
      continue;
    }
    // Words.
    if (isIdStart(c) || (c === '\\' && src[i + 1] === 'u')) {
      while (i < src.length && (isId(src[i]) || src[i] === '\\')) i++;
      push({ kind: 'id', value: src.slice(start, i), start, end: i }, startLine);
      continue;
    }
    if (c === '#' && isIdStart(src[i + 1] ?? '')) {   // a private field name
      i++; while (i < src.length && isId(src[i])) i++;
      push({ kind: 'id', value: src.slice(start, i), start, end: i }, startLine);
      continue;
    }
    // A regular expression, where a value can start.
    if (c === '/') {
      const prev = out[out.length - 1];
      const valueStarts = !prev || (prev.kind === 'punct' && !/^[)\]}]$/.test(prev.value)) || (prev.kind === 'id' && BEFORE_REGEX.has(prev.value));
      if (valueStarts) {
        let k = i + 1, cls = false, ok = false;
        for (; k < src.length && src[k] !== '\n'; k++) {
          if (src[k] === '\\') { k++; continue; }
          if (src[k] === '[') cls = true;
          else if (src[k] === ']') cls = false;
          else if (src[k] === '/' && !cls) { ok = true; break; }
        }
        if (ok) {
          const source = src.slice(i + 1, k);
          let f = k + 1;
          while (f < src.length && /[a-z]/i.test(src[f])) f++;
          i = f;
          push({ kind: 'regex', value: source, flags: src.slice(k + 1, f), start, end: i }, startLine);
          continue;
        }
      }
    }
    const p = PUNCT.find(x => src.startsWith(x, i)) ?? c;
    i += p.length;
    push({ kind: 'punct', value: p, start, end: i }, startLine);
  }
  return out;
}

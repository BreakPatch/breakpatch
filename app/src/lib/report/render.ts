// Fills the report template with a view: the small subset of Mustache the template uses, exactly
// as breakpatch-ci's render.py does (the open engine's breakpatch_engine/report/), so both give
// the same bytes. The golden file engine/tests/fixtures/report/report-*.html checks both.
//
//   {{name}}  {{a.b}}  {{.}}      the value, HTML-escaped (& < > " ')
//   {{#name}} … {{/name}}         once per item of a list, or once when the value is set
//   {{^name}} … {{/name}}         once when the value isn't set (null, false, "", 0, an empty list)
//   {{! comment }}                left out
//
// A name is looked up from the innermost section out, stopping at the first object that has the
// key (even when its value isn't set). No partials, no unescaped output, no whitespace trimming.

type Node = string | { kind: 'name'; name: string } | { kind: '#' | '^'; name: string; children: Node[] };

const TAG = /\{\{![\s\S]*?\}\}|\{\{\s*([#^/]?)\s*([A-Za-z0-9_.]+|\.)\s*\}\}/g;
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export class TemplateError extends Error {}

export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ESCAPES[c]);

export function parse(template: string): Node[] {
  const root: Node[] = [];
  const stack: { name: string | null; children: Node[] }[] = [{ name: null, children: root }];
  let pos = 0;
  const text = (t: string) => {
    if (t.includes('{{')) throw new TemplateError(`a tag the report template doesn't know, near ${JSON.stringify(t.slice(t.indexOf('{{'), t.indexOf('{{') + 30))}`);
    if (t) stack[stack.length - 1].children.push(t);
  };
  for (const m of template.matchAll(TAG)) {
    text(template.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[0].startsWith('{{!')) continue;
    const kind = m[1], name = m[2];
    if (kind === '#' || kind === '^') {
      const node: Node = { kind, name, children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push({ name, children: node.children });
    } else if (kind === '/') {
      if (stack[stack.length - 1].name !== name) throw new TemplateError(`{{/${name}}} closes ${stack[stack.length - 1].name}`);
      stack.pop();
    } else {
      stack[stack.length - 1].children.push({ kind: 'name', name });
    }
  }
  text(template.slice(pos));
  if (stack.length !== 1) throw new TemplateError(`{{#${stack[stack.length - 1].name}}} isn't closed`);
  return root;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isSet(v: unknown): boolean {
  return !(v === null || v === undefined || v === false || v === '' || v === 0 || (Array.isArray(v) && v.length === 0));
}

export function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function lookup(stack: unknown[], name: string): unknown {
  if (name === '.') return stack[stack.length - 1];
  const [first, ...rest] = name.split('.');
  for (let i = stack.length - 1; i >= 0; i--) {
    const ctx = stack[i];
    if (isObject(ctx) && Object.prototype.hasOwnProperty.call(ctx, first)) {
      let v: unknown = ctx[first];
      for (const part of rest) v = isObject(v) ? v[part] : undefined;
      return v;
    }
  }
  return undefined;
}

function walk(nodes: Node[], stack: unknown[], out: string[]) {
  for (const n of nodes) {
    if (typeof n === 'string') { out.push(n); continue; }
    if (n.kind === 'name') { out.push(escapeHtml(textOf(lookup(stack, n.name)))); continue; }
    const v = lookup(stack, n.name);
    if (n.kind === '^') { if (!isSet(v)) walk(n.children, stack, out); continue; }
    if (Array.isArray(v)) {
      for (const item of v) { stack.push(item); walk(n.children, stack, out); stack.pop(); }
    } else if (isSet(v)) {
      stack.push(isObject(v) ? v : stack[stack.length - 1]);
      walk(n.children, stack, out);
      stack.pop();
    }
  }
}

export function render(template: string, view: object): string {
  const out: string[] = [];
  walk(parse(template), [view], out);
  return out.join('');
}

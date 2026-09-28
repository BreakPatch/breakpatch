import { describe, expect, it } from 'vitest';

// Floating panels (menus, the Edit panel, bars over the page) must have a solid surface: a
// CSS variable that isn't defined anywhere leaves them see-through.
const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: string, e: 'utf8'): string; readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean } };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(u: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const src = join(dirname(fileURLToPath(import.meta.url)), '..');

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const n of fs.readdirSync(dir)) {
    const p = join(dir, n);
    if (fs.statSync(p).isDirectory()) cssFiles(p, out); else if (n.endsWith('.css')) out.push(p);
  }
  return out;
}
const files = cssFiles(src);
const text = (end: string) => fs.readFileSync(files.find(f => f.endsWith(end))!, 'utf8');
/** Set inline by the components (style={{ '--s': scale }}), not in a style sheet. */
const INLINE = new Set(['--s', '--su-cols', '--rh-cols']);

describe('design tokens', () => {
  it('defines every CSS variable the style sheets use', () => {
    const all = files.map(f => fs.readFileSync(f, 'utf8')).join('\n');
    const defined = new Set([...all.matchAll(/(--[\w-]+)\s*:/g)].map(m => m[1]));
    const missing = files.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/var\((--[\w-]+)/g)]
      .map(m => m[1]).filter(v => !defined.has(v) && !INLINE.has(v)).map(v => `${v} (${f.slice(src.length + 1)})`));
    expect(missing).toEqual([]);
  });

  it('gives the floating panels a solid surface, a border and a shadow', () => {
    const rule = (css: string, sel: string) => css.match(new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))?.[1] ?? '';
    for (const [file, sel] of [['ui.css', '.menu'], ['steps.css', '.step-editpanel'], ['recorder.css', '.rec-extra']] as const) {
      const r = rule(text(file), sel);
      expect(r, sel).toMatch(/background: var\(--surface\)/);
      expect(r, sel).toMatch(/border: 1px solid var\(--line-strong\)/);
    }
    expect(rule(text('steps.css'), '.step-editpanel')).toMatch(/box-shadow: var\(--shadow-pop\)/);
    expect(text('recorder.css')).toMatch(/\.rec-float > \* \{[^}]*box-shadow: var\(--shadow-pop\)/);
    // Both themes define the surface the panels use.
    expect((text('tokens.css').match(/--surface:/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('draws the open card, with its menu and Edit panel, above the cards after it', () => {
    expect(text('steps.css')).toMatch(/\.step-card\.sel \{ z-index: 30; \}/);
    expect(text('steps.css')).toMatch(/\.step-card \{\s*position: relative;/);
  });
});

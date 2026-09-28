import { describe, expect, it } from 'vitest';
import tauriConf from '../../src-tauri/tauri.conf.json?raw';
import indexHtml from '../../index.html?raw';
import icons from '../assets/fonts/icons.json';
import { iconsNamed } from './iconNames';

// Fonts and icons are bundled (src/assets/fonts, written by scripts/fonts.mjs) so the app works
// offline: without them every icon shows as its name. The icon font is subset to icons.json, so
// an icon added in code must be added there too (run scripts/fonts.mjs with the Team module linked).
// (Node modules are untyped in the app's tsconfig.)
const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync(path: string, enc: 'utf8'): string; readdirSync(path: string): string[]; existsSync(path: string): boolean;
  statSync(path: string): { isDirectory(): boolean };
};
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..');
const fontsDir = join(src, 'assets', 'fonts');
// Read from disk: the test config turns CSS off, so a ?raw CSS import comes back empty.
const globalCss = fs.readFileSync(join(here, 'global.css'), 'utf8');
const fontsCss = fs.readFileSync(join(fontsDir, 'fonts.css'), 'utf8');

/** Every .ts/.tsx file in src, the linked Team module included (statSync follows the link). */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (fs.statSync(p).isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

describe('bundled fonts', () => {
  it('loads nothing from Google Fonts', () => {
    for (const text of [indexHtml, globalCss, fontsCss, tauriConf]) {
      expect(text).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    }
    expect(globalCss).toContain("@import '../assets/fonts/fonts.css';");
  });

  it('keeps the CSP to local fonts and styles', () => {
    const { csp, devCsp } = JSON.parse(tauriConf).app.security;
    for (const c of [csp, devCsp]) {
      expect(c['font-src']).toBe("'self' data:");
      expect(c['style-src']).toBe("'self' 'unsafe-inline'");
    }
  });

  it('has a local file for every font face', () => {
    const urls = [...fontsCss.matchAll(/url\(([^)]+)\)/g)].map(m => m[1]);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toMatch(/^\.\/[a-z0-9-]+\.woff2$/);
      expect(fs.existsSync(join(fontsDir, u))).toBe(true);
    }
    for (const family of ['Bricolage Grotesque', 'JetBrains Mono', 'Material Symbols Outlined']) {
      expect(fontsCss).toContain(`font-family: '${family}'`);
    }
  });

  it('lists the icons once, in order', () => {
    expect(icons).toEqual([...new Set(icons)].sort());
  });

  it('has every icon the code names', () => {
    const have = new Set<string>(icons);
    const missing = new Set<string>();
    let seen = 0;
    for (const f of sources(src)) {
      for (const n of iconsNamed(fs.readFileSync(f, 'utf8'))) { seen++; if (!have.has(n)) missing.add(`${n} (${f.slice(src.length + 1)})`); }
    }
    expect(seen).toBeGreaterThan(100);
    expect([...missing]).toEqual([]);
  });

  it('finds icon names where the code puts them', () => {
    expect(iconsNamed(`<Icon name="bolt" /> <Icon name={ok ? 'check_circle' : 'error'} size={3} />`)).toEqual(['bolt', 'check_circle', 'error']);
    expect(iconsNamed(`<Button icon="send" iconAfter="expand_more">x</Button> { label: 'Edit', icon: 'edit' }`)).toEqual(['send', 'expand_more', 'edit']);
    expect(iconsNamed(`<span className="icon sweep">radar</span> <input name="username" />`)).toEqual(['radar']);
    expect(iconsNamed(`<Icon name={s === 'paused' ? 'pause_circle' : 'schedule'} className="faint" /> <Icon name={{ up: 'arrow_upward' }[d]} />`)).toEqual(['pause_circle', 'schedule', 'arrow_upward']);
  });
});

#!/usr/bin/env node
// Refreshes the bundled fonts in src/assets/fonts (the app works offline, so nothing is loaded
// from Google Fonts at runtime):
//   - Bricolage Grotesque and JetBrains Mono (SIL OFL 1.1): the same variable woff2 files and
//     @font-face rules Google Fonts serves a current Chrome, with the URLs pointed at local files;
//   - Material Symbols Outlined (Apache 2.0), subset to the icons the app uses (icons.json) with
//     Google Fonts' icon_names, keeping the FILL and opsz axes.
//
// Icons: every quoted or JSX-text word in src/**/*.ts(x) that is a Material Symbols name. That is
// deliberately generous (a word like 'search' is kept whether or not it's an icon); a missing icon
// would show as its name. The Team module's icons count too, so link it first
// (scripts/link-team.sh), or pass --without-team to keep the Team names already in icons.json.
//
//   node scripts/fonts.mjs            # needs the network; run from app/
//
// src/assets/fonts/fonts.test.ts checks that every icon the code names is in icons.json.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(app, 'src');
const out = join(src, 'assets', 'fonts');
const withoutTeam = process.argv.includes('--without-team');

// A current desktop Chrome, so Google Fonts answers with woff2 and unicode-range subsets.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TEXT_CSS = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,400;12..96,500;12..96,600;12..96,700&family=JetBrains+Mono:wght@400;500&display=swap';
const ICON_AXES = 'Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..24,400,0..1,0';
const CODEPOINTS = 'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints';

async function get(url, as = 'text') {
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return as === 'bytes' ? Buffer.from(await r.arrayBuffer()) : r.text();
}

/** Every .ts/.tsx file under dir, following the Team module's link. */
function sources(dir, list = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) sources(p, list);
    else if (/\.tsx?$/.test(name)) list.push(p);
  }
  return list;
}

const teamLink = join(src, 'edition', 'team');
const teamLinked = existsSync(join(teamLink, 'index.ts')) && lstatSync(teamLink).isSymbolicLink();
if (!teamLinked && !withoutTeam) {
  console.error('fonts: the Team module isn\'t linked, so its icons would be left out. Run scripts/link-team.sh first, or pass --without-team.');
  process.exit(1);
}

// ---- Icons
const known = new Set((await get(CODEPOINTS)).split('\n').map(l => l.split(' ')[0]).filter(Boolean));
const words = new Set();
for (const f of sources(src)) {
  for (const m of readFileSync(f, 'utf8').matchAll(/(?<=['"`>])[a-z][a-z0-9_]*(?=['"`<])/g)) words.add(m[0]);
}
const iconsFile = join(out, 'icons.json');
const before = existsSync(iconsFile) ? JSON.parse(readFileSync(iconsFile, 'utf8')) : [];
const icons = [...words].filter(w => known.has(w));
if (withoutTeam) icons.push(...before.filter(n => known.has(n)));
const names = [...new Set(icons)].sort();

// ---- Download
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith('.woff2')) rmSync(join(out, f));
const files = new Map(); // remote url → local file name

/** Replaces each remote url() with a local file, named after the family and the subset comment. */
async function localise(css, family) {
  let subset = '';
  const lines = [];
  for (const line of css.split('\n')) {
    const c = /^\/\* (.+) \*\/$/.exec(line.trim());
    if (c) subset = c[1];
    const fam = /font-family: '([^']+)'/.exec(line);
    if (fam) family = fam[1];
    const u = /url\((https:[^)]+)\)/.exec(line);
    if (u) {
      if (!files.has(u[1])) {
        const base = family.toLowerCase().replace(/\s+/g, '-') + (subset ? `-${subset.replace(/[^a-z0-9]+/gi, '-')}` : '');
        files.set(u[1], `${base}.woff2`);
        writeFileSync(join(out, `${base}.woff2`), await get(u[1], 'bytes'));
      }
      lines.push(line.replace(u[1], `./${files.get(u[1])}`));
    } else lines.push(line);
  }
  return lines.join('\n');
}

const textCss = await localise(await get(TEXT_CSS), '');
const iconCssRemote = await get(`https://fonts.googleapis.com/css2?family=${ICON_AXES}&icon_names=${names.join(',')}&display=block`);
// Only the @font-face rule; global.css has its own .icon class.
const iconFace = /@font-face\s*\{[^}]*\}/.exec(iconCssRemote)?.[0];
if (!iconFace) throw new Error('No @font-face in the Material Symbols answer');
const iconCss = await localise(iconFace, 'Material Symbols Outlined');

writeFileSync(join(out, 'fonts.css'), `/* Bundled fonts, so the app works offline. Written by scripts/fonts.mjs: don't edit by hand.
 * Bricolage Grotesque and JetBrains Mono: SIL Open Font License 1.1 (OFL-*.txt here).
 * Material Symbols Outlined: Apache License 2.0, subset to the icons in icons.json. */
${textCss.trim()}

${iconCss.trim()}
`);
writeFileSync(iconsFile, JSON.stringify(names, null, 2) + '\n');
for (const [dir, name] of [['bricolagegrotesque', 'OFL-BricolageGrotesque.txt'], ['jetbrainsmono', 'OFL-JetBrainsMono.txt']]) {
  writeFileSync(join(out, name), await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${dir}/OFL.txt`));
}
const added = names.filter(n => !before.includes(n)), dropped = before.filter(n => !names.includes(n));
console.log(`fonts: ${files.size} font files, ${names.length} icons${added.length ? `, added ${added.join(' ')}` : ''}${dropped.length ? `, dropped ${dropped.join(' ')}` : ''}`);

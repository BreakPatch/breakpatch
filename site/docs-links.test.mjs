// The Documentation page (/docs/, built from docs/manual.md by build-manual.mjs): the old /manual/
// address redirects to it, nothing links to /manual/ any more, and every link into it names a
// section the page has. No browser, nothing to install.
//   node --test site/docs-links.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from './build-manual.mjs';

const SITE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(SITE, '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');
const PAGE = read('site/docs/index.html');
const MD = read('docs/manual.md');
const IDS = new Set([...PAGE.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]));

/** Every file under `dir` (relative to the repo) whose name matches `re`, without node_modules. */
function files(dir, re) {
  const out = [];
  const walk = d => {
    for (const name of readdirSync(join(ROOT, d))) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(d, name);
      if (statSync(join(ROOT, p)).isDirectory()) walk(p);
      else if (re.test(name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** What links to the page: the site, the install commands, the READMEs and the app's own links. */
const SOURCES = [
  ...files('site', /\.(html|js)$|^install-ci(\.ps1)?$/).filter(p => !p.startsWith(join('site', 'docs'))),
  ...files('app/src', /\.tsx?$/).filter(p => !/\.test\.tsx?$/.test(p)),
  'README.md', 'CONTRIBUTING.md', 'docs/manual.md',
];

test('/manual/ redirects to /docs/ for good, so old links and their #sections still open', () => {
  const { hosting } = JSON.parse(read('site/firebase.json'));
  const to = Object.fromEntries((hosting.redirects ?? []).map(r => [r.source, r]));
  for (const source of ['/manual', '/manual/', '/manual/**']) {
    assert.equal(to[source]?.destination, '/docs/', source);
    assert.equal(to[source]?.type, 301, source);
  }
  // A redirect's Location has no #part, so the browser keeps the old link's section.
  for (const r of hosting.redirects) assert.doesNotMatch(r.destination, /#/);
});

test('the page is the Documentation, built from docs/manual.md', () => {
  assert.equal(PAGE, build(MD), 'run: node site/build-manual.mjs');
  assert.match(PAGE, /<title>Breakpatch documentation<\/title>/);
  assert.match(PAGE, /<link rel="canonical" href="https:\/\/breakpatch\.dev\/docs\/">/);
  assert.match(PAGE, /<a href="\/docs\/" aria-current="page">Docs<\/a>/);
  assert.match(PAGE, /<h1>Documentation<\/h1>/);
  assert.match(MD, /^# Breakpatch documentation\n/);
  assert.match(read('site/sitemap.xml'), /<loc>https:\/\/breakpatch\.dev\/docs\/<\/loc>/);
});

test('nothing links to /manual/ any more, and menus say Docs', () => {
  for (const p of [...SOURCES, 'site/sitemap.xml', 'site/install']) {
    const text = read(p);
    assert.doesNotMatch(text, /breakpatch\.dev\/manual\b|href="(\.\.)?\/manual\b|href="\.\.\/manual\//, p);
    assert.doesNotMatch(text, />Manual<\/a>/, p);
  }
});

test('every link into the Documentation names a section it has', () => {
  const links = [];
  for (const p of SOURCES) {
    const text = read(p);
    for (const m of text.matchAll(/(?:https:\/\/breakpatch\.dev\/docs\/|href="(?:\.\.)?\/docs\/)#([A-Za-z0-9-]+)/g)) links.push([p, m[1]]);
  }
  // The page's own links, and the Markdown's (they're the same on GitHub).
  for (const m of PAGE.matchAll(/href="#([^"]+)"/g)) links.push(['site/docs/index.html', m[1]]);
  for (const m of MD.matchAll(/\]\(#([^)]+)\)/g)) links.push(['docs/manual.md', m[1]]);
  assert.ok(links.length > 100, `found ${links.length} links`);
  const broken = links.filter(([, id]) => id !== 'main' && !IDS.has(id));
  assert.deepEqual(broken, []);
});

test('the sections other places link to by name keep their anchors', () => {
  // The Team app (Settings → Local runner → How run requests work), the install commands, and the
  // site's pages link to these. Renaming one of these headings breaks those links.
  for (const id of ['run-requests', 'privacy', 'recorded-on-another-system', 'from-ci-with-breakpatch-ci',
    'breakpatch-ci-on-windows', 'using-breakpatch-on-a-company-network', 'licences-and-seats', 'create-a-workspace',
    'install', 'record-a-test', 'the-ai-assistant', 'the-tests-folder', 'the-local-runner', 'fixed-automatically',
    'run-a-test-and-read-the-report', 'solo', 'encryption-and-the-recovery-code', 'result-messages']) {
    assert.ok(IDS.has(id), id);
  }
});

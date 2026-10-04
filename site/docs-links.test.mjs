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

test('notes render as notes, never as a comment in the text', () => {
  assert.doesNotMatch(PAGE, /&lt;!--/);
  // Team and Business aren't on sale yet: the Team part says so first, in a note that always shows.
  const team = PAGE.slice(PAGE.indexOf('<header class="part" id="team">'), PAGE.indexOf('</header>', PAGE.indexOf('<header class="part" id="team">')));
  assert.match(team, /<p class="soon" role="note"><span class="dot" aria-hidden="true"><\/span><span>Coming later\. Team and Business aren't on sale yet, and their pricing is to be decided\./);
  assert.match(PAGE, /<section id="hosted-by-breakpatch" class="team">[\s\S]*?<p class="soon" role="note">/);
  assert.throws(() => build('# T\n\nx\n\n---\n\n# P\n\n## S\n\n<!-- later --> Something.\n'), /Unknown note/);
});

test('nothing says Coming soon for Team, Business, Solo or hosting: they are coming later', () => {
  for (const m of MD.matchAll(/<!--\s*(?:soon|solo-soon)\s*-->\s*(.*)/g)) assert.match(m[1], /^Coming later\./, m[1]);
  assert.doesNotMatch(MD, /Opens soon/);
});

test('a program’s output is shown without a Copy button, and wraps on a phone', () => {
  const html = build('# T\n\nx\n\n---\n\n# P\n\n## S\n\n```output\nbreakpatch-ci: simple runner (4 GB)\n```\n\n```sh\nbreakpatch-ci run\n```\n');
  assert.match(html, /<div class="code output"><pre><code>breakpatch-ci: simple runner \(4 GB\)<\/code><\/pre><\/div>/);
  assert.match(html, /<div class="code"><button class="copy" type="button">Copy<\/button><pre><code data-lang="sh">breakpatch-ci run/);
  // The runner tiers' example log is one.
  assert.match(PAGE, /<div class="code output"><pre><code>breakpatch-ci: simple runner/);
  assert.match(read('site/assets/site.css'), /\.code\.output pre code\{white-space:pre-wrap/);
});

test('a table after <!-- stack --> stacks on a phone, each cell named by its column', () => {
  const html = build('# T\n\nx\n\n---\n\n# P\n\n## S\n\n<!-- stack -->\n| | A | **B** |\n|---|---|---|\n| One | yes | no |\n');
  assert.match(html, /<table class="stack"><thead><tr><th><\/th><th>A<\/th><th><strong>B<\/strong><\/th><\/tr><\/thead><tbody><tr><td>One<\/td><td data-label="A">yes<\/td><td data-label="B">no<\/td><\/tr>/);
  const tiers = PAGE.slice(PAGE.indexOf('id="runner-tiers"'));
  assert.match(tiers, /^[^]*?<table class="stack">[^]*?<td data-label="Simple runner">/);
});

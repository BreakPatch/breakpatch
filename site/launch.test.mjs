// The public beta (v0.1.0-beta.1): no pre-launch notes are left anywhere, and Community carries a
// small Beta label where it's offered (site/README.md, "Launch day"). No browser, nothing to install.
//   node --test site/launch.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

/** Every .html file under site/, without node_modules. */
function pages(dir = 'site') {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(join(ROOT, p)).isDirectory()) out.push(...pages(p));
    else if (name.endsWith('.html')) out.push(p);
  }
  return out;
}

const HOME = read('site/index.html');
const PRICING = read('site/pricing/index.html');
const MANUAL = read('docs/manual.md');
const README = read('README.md');
const CSS = read('site/assets/site.css');
const BETA = '<span class="beta-tag">Beta</span>';

test('no page has data-prelaunch or a pre-launch note, the Documentation included', () => {
  const all = pages();
  assert.ok(all.length >= 10, 'found the pages');
  for (const p of all) {
    const html = read(p);
    assert.doesNotMatch(html, /data-prelaunch/, p);
    assert.doesNotMatch(html, /class="prelaunch(-text)?"/, p);
    assert.doesNotMatch(html, /Public release coming soon|once the public release is out|until the public release/i, p);
  }
  assert.doesNotMatch(read('site/build-manual.mjs'), /<html[^>]*data-prelaunch/);
  assert.doesNotMatch(MANUAL, /<!--\s*prelaunch\s*-->/);
});

test('nothing says the repository is private or the release is coming', () => {
  for (const [name, text] of [['README.md', README], ['docs/manual.md', MANUAL], ['site/assets/site.js', read('site/assets/site.js')]]) {
    assert.doesNotMatch(text, /Public release coming soon|while it's private|is private until|BREAKPATCH_GITHUB_TOKEN=<token>/i, name);
  }
});

test('Community is labelled Beta on Home (install area and its card) and on Pricing', () => {
  assert.ok(HOME.includes(`<p class="reqs">${BETA}Free and open source`), 'Home: the requirements line under the install command');
  assert.ok(HOME.includes(`<h3>Community${BETA}</h3>`), 'Home: the Community card');
  assert.ok(PRICING.includes(`<h2 id="community-title">Community${BETA}</h2>`), 'Pricing: the Community card');
  assert.ok(CSS.includes('.beta-tag{'), 'site.css styles it');
});

test('Team, Business and Solo get no Beta label, and still no price for Team and Business', () => {
  const card = (html, start) => html.slice(html.indexOf(start), html.indexOf('</article>', html.indexOf(start)));
  for (const [name, c] of [
    ['Home Team', card(HOME, '<article class="plan plan-team')],
    ['Pricing Team', card(PRICING, 'plan-team')],
    ['Pricing Business', card(PRICING, 'plan-business')],
    ['Pricing Solo', card(PRICING, 'class="edition plan-solo')],
  ]) {
    assert.ok(c.length > 100, name + ' found');
    assert.doesNotMatch(c, /beta-tag/, name);
  }
  assert.equal((HOME.match(/beta-tag/g) || []).length, 2, 'Home: two Beta labels');
  assert.equal((PRICING.match(/beta-tag/g) || []).length, 1, 'Pricing: one Beta label');
});

test('the Documentation and the README say what beta means, where to report problems, and that updates come by themselves', () => {
  const install = MANUAL.slice(MANUAL.indexOf('## Install\n'), MANUAL.indexOf('\n## ', MANUAL.indexOf('## Install\n') + 5));
  for (const text of [install, README]) {
    assert.match(text, /Breakpatch Community is a beta/);
    assert.match(text, /rough edges/);
    assert.match(text, /github\.com\/BreakPatch\/breakpatch\/issues/);
    assert.match(text, /support@breakpatch\.dev/);
  }
  assert.match(install, /arrive by themselves/);
  assert.ok(read('site/docs/index.html').includes('Breakpatch Community is a beta'), 'the built page has it (node site/build-manual.mjs)');
  assert.match(README, /alt="Community: beta"/);
});

test('the release notes for v0.1.0-beta.1 are there (release.yml publishes docs/releases/<tag>.md)', () => {
  const notes = read('docs/releases/v0.1.0-beta.1.md');
  assert.ok(read('.github/workflows/release.yml').includes('contents/docs/releases/$GITHUB_REF_NAME.md'));
  assert.match(notes, /curl -fsSL https:\/\/breakpatch\.dev\/install \| sh/);
  assert.match(notes, /Apple Silicon/);
  assert.match(notes, /macOS 14/);
  assert.match(notes, /support@breakpatch\.dev/);
  assert.equal(JSON.parse(read('app/package.json')).version, '0.1.0-beta.1');
});

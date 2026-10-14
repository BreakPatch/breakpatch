// The Documentation (docs/manual.md, built into site/docs/index.html) promises only what a release
// has. The latest release, v0.1.0-beta.2, has no Linux desktop app, no container image and not
// breakpatch-ci's library check, so the page says what's coming later and marks what's new in
// 0.1.0-beta.3. No browser, nothing to install.
//   node --test site/manual-releases.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = p => readFileSync(join(ROOT, p), 'utf8');
const MD = read('docs/manual.md');
const PAGE = read('site/docs/index.html');

/** A heading's text in the Markdown, up to the next heading of the same level or higher. */
function mdSection(heading) {
  const level = heading.match(/^#+/)[0].length;
  const start = MD.indexOf(`\n${heading}\n`);
  assert.ok(start >= 0, `no heading ${heading}`);
  const rest = MD.slice(start + heading.length + 2);
  const end = rest.search(new RegExp(`^#{1,${level}} `, 'm'));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The page's HTML from the element with this id up to the next h2 or h3. */
function pageSection(id) {
  const start = PAGE.indexOf(` id="${id}"`);
  assert.ok(start >= 0, `no #${id} on the page`);
  const rest = PAGE.slice(start);
  const end = rest.slice(1).search(/<h[23][ >]/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const firstBlock = html => html.slice(html.indexOf('>') + 1).match(/<(p|ul|ol|div|h\d)[^>]*>[\s\S]*?<\/\1>/)[0];

test('Install says Linux comes next, as the home page and the README do', () => {
  const install = mdSection('## Install');
  assert.match(install.split('\n').find(l => l.startsWith('You need a Mac')), /Linux comes next, then Windows/);
  assert.match(read('README.md'), /Linux comes next, then Windows/);
  assert.match(read('site/index.html'), /Linux comes next, then Windows\./);
  assert.doesNotMatch(MD, /Linux is in preview/);
});

test('the Linux app is coming later: no release has it, and nothing says how to get or update it', () => {
  const md = mdSection('### Breakpatch on Linux (preview)');
  const html = pageSection('breakpatch-on-linux-preview');
  assert.match(firstBlock(html), /^<p class="soon" role="note">.*Coming later\. No release has the Linux app yet\./);
  assert.doesNotMatch(md, /\.deb|Not every release has it/);
  assert.doesNotMatch(md, /AI assistant|Apple Silicon/);
  // Updates and the rest of the page don't send anyone to a .deb either.
  assert.doesNotMatch(mdSection('## Updates'), /\.deb|Linux/);
  assert.doesNotMatch(MD, /\]\(#breakpatch-on-linux-preview\)/);
});

test('breakpatch-ci’s library check is marked as new in 0.1.0-beta.3, everywhere it’s described', () => {
  const lines = MD.split('\n').filter(l => /libraries\.missing|code: "libraries"|missing system libraries|it names them/.test(l));
  assert.ok(lines.length >= 4, `found ${lines.length}`);
  for (const l of lines) assert.match(l, /\b[Ff]rom 0\.1\.0-beta\.3\b/, l);
  // Before that, setup still installs the browser, and the install command still gives the command.
  const linux = mdSection('### breakpatch-ci on Linux');
  assert.match(linux, /^`breakpatch-ci setup` installs the test browser again if it's missing\. It needs no licence\.$/m);
  assert.match(linux, /At the end, the install command gives the command that adds them\. From 0\.1\.0-beta\.3, it checks/);
});

test('the container image comes with a later release, and nothing sends anyone to it now', () => {
  const md = mdSection('### breakpatch-ci in a container');
  const html = pageSection('breakpatch-ci-in-a-container');
  assert.match(firstBlock(html), /^<p class="soon" role="note">.*Coming later\. No release has the container image yet: it comes with a later release\./);
  assert.doesNotMatch(MD, /Releases after 0\.1\.0/);
  // Every release from then on is tagged, betas included, as release.yml's ci-image does it.
  assert.match(md, /Every release from then on comes as an image, betas included, each with its own tag/);
  const wf = read('.github/workflows/release.yml');
  assert.match(wf, /tags=\(-t "\$IMAGE:\$version"\)/);
  assert.match(wf, /\*-\*\) echo "A prerelease: \$IMAGE:latest stays where it is\." ;;/);
  // Outside its own section, the image is only ever named as coming later.
  const outside = MD.replace(md, '');
  for (const l of outside.split('\n').filter(l => /ghcr\.io|#breakpatch-ci-in-a-container\)/.test(l))) {
    if (/\[breakpatch-ci in a container\]\(#breakpatch-ci-in-a-container\)/.test(l) && !/ghcr/.test(l)) continue;
    assert.match(l, /comes with a later release/, l);
  }
  assert.doesNotMatch(read('site/install-ci'), /ghcr\.io/);
});

test('the GitHub Action the manual names is linked, and its README is there', () => {
  const line = MD.split('\n').find(l => l.includes('BREAKPATCH_LICENCE_FILE`: where the licence is kept'));
  assert.match(line, /\[GitHub Action\]\(https:\/\/github\.com\/BreakPatch\/breakpatch\/blob\/main\/action\/README\.md\), a draft for now, seals it/);
  assert.ok(existsSync(join(ROOT, 'action', 'README.md')));
  assert.match(read('action/README.md'), /It's a draft/);
});

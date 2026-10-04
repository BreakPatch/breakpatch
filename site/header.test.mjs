// The header on phones: the main links fold into a Menu button, so nothing runs under Install.
//   node --test site/header.test.mjs
// The rules are checked here as text; header-check.py then checks every page in a real browser at
// 360, 390 and 430 px (no sideways scroll, nothing in the header overlapping or sticking out, the
// menu opening and closing). That part runs when Python's Playwright and a Chromium are on this
// machine (BP_CHROMIUM, or /opt/pw-browsers/chromium), and is skipped, saying so, when they aren't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const CSS = read('./assets/site.css');
const JS = read('./assets/site.js');
const phone = CSS.slice(CSS.indexOf('@media (max-width:560px){'), CSS.indexOf('@media (max-width:400px){'));

test('on phones the links fold into a Menu button next to Install', () => {
  for (const rule of ['.top.has-menu nav{display:none}', '.has-menu .nav-toggle{display:inline-flex}', '.top .btn{min-height:44px}',
    '.top.has-menu.open nav{display:flex;flex-direction:column;']) assert.ok(phone.includes(rule), rule);
  // 44 x 44, hidden until a phone width.
  assert.match(CSS, /\.nav-toggle\{display:none;[^}]*width:44px;height:44px;/);
  // Without JavaScript the links stay in the bar and scroll there, rather than running under Install.
  assert.ok(phone.includes('.top:not(.has-menu) nav{overflow-x:auto;'));
  // Each link in the open menu is a full-width row at least 48 px tall.
  assert.match(phone, /\.top\.has-menu\.open nav a,\.top\.has-menu\.open nav a\.wide\{display:flex;align-items:center;min-height:48px;/);
});

test('the Menu button is a real button: aria-expanded, aria-controls, Esc closes and gives focus back', () => {
  for (const s of ["toggle.type = 'button'", "toggle.setAttribute('aria-expanded', 'false')", "toggle.setAttribute('aria-controls', mainNav.id)",
    "toggle.setAttribute('aria-label', 'Menu')", "toggle.setAttribute('aria-expanded', String(open))",
    "e.key === 'Escape' && isOpen()", 'setOpen(false, true)', 'if (!open && focus) toggle.focus()', "mainNav.querySelector('a')?.focus()"]) assert.ok(JS.includes(s), s);
  // It goes before the links, so Tab moves from the button into the open menu.
  assert.ok(JS.includes('mainNav.before(toggle)'));
});

test('the install command stays on one line on phones, with Copy at its end', () => {
  assert.ok(phone.includes('.install-cmd pre{padding:0 0 0 14px;overflow-x:auto;'));
  assert.ok(phone.includes('.install-cmd pre code{display:inline-block;padding-right:92px;line-height:56px;font-size:0.8125rem;white-space:pre}'));
  assert.doesNotMatch(phone, /\.install-cmd pre code\{[^}]*pre-wrap/);
  assert.match(phone, /\.install-cmd \.copy\{top:1px;bottom:1px;right:1px;[^}]*min-height:44px/);
});

test('the hero badge keeps its dot with the words after it, and on a phone has none to orphan', () => {
  const home = read('./index.html');
  assert.ok(home.includes('AI on your Mac</span><span class="soft"><span>no cloud<a class="star" href="#no-cloud"'));
  assert.match(phone, /\.ai-badge\{[^}]*flex-direction:column/);
  assert.ok(phone.includes('.ai-badge .soft::before{display:none}'));
  // The asterisk is a 44 px target without moving the words: padding, taken back by a negative margin.
  assert.match(CSS, /\.ai-badge \.star\{position:relative;display:inline-block;padding:12px 19px;margin:-12px -19px -12px calc\(1px - 19px\);line-height:20px/);
  // The asterisk on "no cloud" leads to the note that says where the cloud does come in.
  assert.ok(home.includes('<p class="cloud-note" id="no-cloud">'));
  assert.doesNotMatch(home, /class="sep"/);
  assert.ok(CSS.includes('.ai-badge .soft::before{content:"";width:4px;height:4px;border-radius:50%;'));
});

const chromium = process.env.BP_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '');
const playwright = spawnSync('python3', ['-c', 'import playwright'], { stdio: 'ignore' }).status === 0;

test('every page at 360, 390 and 430 px: no sideways scroll, nothing overlapping in the header (real browser)', { skip: !(chromium && playwright) && 'needs Python Playwright and a Chromium (BP_CHROMIUM)', timeout: 300_000 }, () => {
  const run = spawnSync('python3', [fileURLToPath(new URL('./header-check.py', import.meta.url))], { encoding: 'utf8', env: { ...process.env, BP_CHROMIUM: chromium } });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('docs code on a phone: Copy never covers the first line (WEB-03), and footer links are tap-sized (WEB-05)', () => {
  // Commands wrap and keep room beside the 44 px Copy; other code starts below it.
  assert.ok(phone.includes('.code:not(.install-cmd,.output) pre{padding:60px 16px 14px}'));
  assert.ok(phone.includes('.code pre code[data-lang="sh"]::before{content:"";float:right;width:72px;height:40px}'));
  assert.ok(phone.includes('.foot-links a,.foot-brand p a{display:inline-flex;align-items:center;min-height:44px}'));
});

// Checks the home page's "12,300 tests run with Breakpatch" line (assets/runs-count.js, with
// assets/get-json.js) against the real index.html: no browser, nothing to install.
//   node --test site/runs-count.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const HOME = read('./index.html');
const GET_JSON = read('./assets/get-json.js');
const JS = read('./assets/runs-count.js');
const CSS = read('./assets/site.css');
const URL_ = 'https://account.breakpatch.dev/api/test-runs';

/** The two elements the script touches, as index.html serves them. */
function elements() {
  const line = HOME.match(/<p class="runs-count" id="runs-count"( hidden)?>/);
  assert.ok(line, 'the line is on the page');
  return { 'runs-count': { hidden: !!line[1] }, 'runs-count-n': { textContent: '' } };
}

/**
 * Runs the scripts with GET /api/test-runs answering `answer`: a body, a status number, 'offline',
 * or 'slow' (no answer until the 5 s timer aborts it). Returns the elements and the fetches.
 */
async function load(answer) {
  const byId = elements(), fetched = [], timers = [];
  const window = {
    fetch: (url, init) => {
      fetched.push({ url, credentials: init.credentials });
      if (answer === 'offline') return Promise.reject(new TypeError('Failed to fetch'));
      if (answer === 'slow') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
      if (typeof answer === 'number') return Promise.resolve({ ok: false, status: answer, json: async () => ({ ok: false }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => structuredClone(answer) });
    },
  };
  // The 5 s timer: recorded, and fired by hand for 'slow'.
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const ctx = vm.createContext({ window, document: { getElementById: id => byId[id] ?? null }, setTimeout, clearTimeout() {}, AbortController, Promise, Number });
  vm.runInContext(GET_JSON, ctx);
  vm.runInContext(JS, ctx);
  if (answer === 'slow') { assert.equal(timers[0].ms, 5000); timers[0].fn(); }
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
  return { line: byId['runs-count'], n: byId['runs-count-n'], fetched, timers };
}

test('from 100 runs the line shows the number, as the back office rounded it', async () => {
  for (const [runs, shown] of [[100, '100'], [990, '990'], [12300, '12,300'], [1_234_000, '1,234,000']]) {
    const p = await load({ runs });
    assert.equal(p.line.hidden, false, String(runs));
    assert.equal(p.n.textContent, shown);
    assert.deepEqual(p.fetched, [{ url: URL_, credentials: 'omit' }]);
  }
  assert.ok(HOME.includes('<b id="runs-count-n"></b> tests run with Breakpatch</p>'));
});

test('below 100 runs the line stays hidden', async () => {
  for (const runs of [0, 1, 90, 99]) {
    const p = await load({ runs });
    assert.equal(p.line.hidden, true, String(runs));
    assert.equal(p.n.textContent, '');
  }
});

test('when the answer doesn’t come, or isn’t a count, the line stays hidden', async () => {
  for (const answer of ['offline', 'slow', 503, 429, 404, { ok: false }, {}, null, { runs: '12300' }, { runs: 150.5 }, { runs: -200 }, { runs: 2 ** 60 }]) {
    const p = await load(answer);
    assert.equal(p.line.hidden, true, JSON.stringify(answer));
    assert.equal(p.n.textContent, '');
  }
});

test('nothing moves: hidden as served, out of the flow, fading in, under the install command', () => {
  assert.ok(HOME.includes('<p class="runs-count" id="runs-count" hidden>'));
  const install = HOME.slice(HOME.indexOf('<div class="install" id="install">'), HOME.indexOf('<figure class="hero-shot">'));
  assert.ok(install.includes('id="runs-count"'), 'inside the install block, above the screenshot');
  assert.match(CSS, /\.runs-count\{position:absolute;top:calc\(100% \+ 12px\);[^}]*animation:edge \.6s ease-out both\}/);
  assert.match(CSS, /\.install\{position:relative;/);
  // The shared helper first, then the line; and the same helper on /pricing.
  assert.ok(HOME.indexOf('/assets/get-json.js') > 0 && HOME.indexOf('/assets/get-json.js') < HOME.indexOf('/assets/runs-count.js'));
  const PRICING = read('./pricing/index.html');
  assert.ok(PRICING.indexOf('../assets/get-json.js') < PRICING.indexOf('../assets/pricing.js'));
  assert.doesNotMatch(read('./assets/pricing.js'), /window\.fetch\(/, 'pricing.js has no fetch of its own');
});

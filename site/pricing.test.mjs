// Checks /pricing's plan picker (assets/pricing.js) against the real pricing/index.html, with a
// tiny DOM stand-in and Paddle.js stubbed: no browser, nothing to install.
//   node --test site/pricing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HTML = readFileSync(new URL('./pricing/index.html', import.meta.url), 'utf8');
const JS = readFileSync(new URL('./assets/pricing.js', import.meta.url), 'utf8');

class El {
  constructor(tag, attrs) {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    this.hidden = 'hidden' in attrs;
    this.checked = 'checked' in attrs;
    this.disabled = 'disabled' in attrs;
    this.value = attrs.value ?? '';
    this.textContent = '';
    this.listeners = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type, ev = {}) { for (const fn of this.listeners[type] ?? []) fn({ preventDefault() {}, ...ev }); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  removeAttribute(k) { delete this.attrs[k]; }
  reportValidity() { return true; }
  click() { if (this.attrs.type === 'checkbox') this.checked = !this.checked; this.fire(this.attrs.type === 'checkbox' ? 'change' : 'click'); }
}

function parse(html) {
  const byId = {}, all = [];
  for (const m of html.matchAll(/<([a-z]+)((?:\s+[a-zA-Z-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] ?? '';
    const el = new El(m[1], attrs);
    all.push(el);
    if (attrs.id) byId[attrs.id] = el;
  }
  return { byId, all };
}

const plain = v => JSON.parse(JSON.stringify(v)); // out of the page's realm, for deepEqual

/**
 * Loads the page with this Paddle config. `places` is what GET /api/founding answers: a body, a
 * status number, or 'offline'. Returns the elements, Paddle's checkout calls and the fetches.
 */
async function load(config, places = { total: 25, taken: 0 }) {
  const { byId, all } = parse(HTML);
  const opened = [], fetched = [];
  const window = {
    BREAKPATCH_PADDLE: config,
    matchMedia: () => ({ matches: false }),
    fetch: async (url, init) => {
      fetched.push({ url, credentials: init?.credentials });
      if (places === 'offline') throw new TypeError('Failed to fetch');
      if (typeof places === 'number') return { ok: false, status: places, json: async () => ({ ok: false }) };
      return { ok: true, status: 200, json: async () => structuredClone(places) };
    },
  };
  const document = {
    getElementById: id => byId[id] ?? null,
    querySelectorAll: sel => {
      const attr = /^\[([a-z-]+)\]$/.exec(sel)?.[1];
      assert.ok(attr, `unexpected selector ${sel}`);
      return all.filter(e => attr in e.attrs);
    },
    createElement: tag => new El(tag, {}),
    head: {
      appendChild(s) {
        assert.equal(s.src, 'https://cdn.paddle.com/paddle/v2/paddle.js');
        window.Paddle = {
          Environment: { set() {} },
          Initialize() {},
          Checkout: { open: opts => opened.push(plain(opts)) },
        };
        s.onload();
      },
    },
  };
  const ctx = vm.createContext({ window, document, location: { href: 'https://breakpatch.dev/pricing/', search: '' }, URL, setTimeout, clearTimeout, AbortController });
  vm.runInContext(JS, ctx);
  await new Promise(r => setImmediate(r)); // the places answer
  const $ = id => byId[id];
  const buy = async () => { $('team-form').fire('submit'); await new Promise(r => setImmediate(r)); return opened.at(-1); };
  const period = p => all.find(e => e.dataset.period === p).click();
  return { $, buy, period, opened, fetched };
}

const prices = { teamMonthly: 'pri_tm', teamYearly: 'pri_ty', machineMonthly: 'pri_mm', machineYearly: 'pri_my' };
const URL_ = 'https://account.breakpatch.dev/api/founding';
const cfg = (extra = {}) => ({ env: 'sandbox', foundingPlacesUrl: URL_, sandbox: { clientToken: 'test_x', prices, ...extra }, live: { prices: {} } });
const FOUNDING = { foundingDiscountId: 'dsc_01test' };
const TITLE = 'Founding teams: $12/person/month for 24 months — ';

test('without a founding discount nothing shows and checkout has no discount', async () => {
  for (const c of [cfg(), cfg({ foundingDiscountId: '' }), cfg({ foundingDiscountId: 'pri_ty' })]) {
    const { $, buy, fetched } = await load(c);
    assert.equal(fetched.length, 0); // nothing asked of the back office either
    assert.equal($('founding').hidden, true);
    assert.equal($('founding-opt').hidden, true);
    assert.equal($('team-price').textContent, '$16');
    assert.equal($('total').textContent, '$960 a year');
    const opts = await buy();
    assert.deepEqual(opts.items, [{ priceId: 'pri_ty', quantity: 5 }]);
    assert.equal('discountId' in opts, false);
  }
});

test('the founding offer: places left, $12 on Team yearly, discountId passed to checkout', async () => {
  const { $, buy, fetched } = await load(cfg(FOUNDING), { total: 25, taken: 7 });
  assert.deepEqual(plain(fetched), [{ url: URL_, credentials: 'omit' }]);
  assert.equal($('founding').hidden, false);
  assert.equal($('founding-title').textContent, TITLE + '18 of 25 places left');
  assert.equal($('founding-opt').hidden, false);
  assert.equal($('team-price').textContent, '$12');
  assert.match($('team-per').textContent, /billed yearly, for 24 months/);
  assert.equal($('total').textContent, '$720 a year'); // 5 × $12 × 12
  const opts = await buy();
  assert.equal(opts.discountId, 'dsc_01test');
  assert.deepEqual(opts.items, [{ priceId: 'pri_ty', quantity: 5 }]);
  assert.deepEqual(opts.customer, { email: '' });
});

test('founding is Team yearly only, and the buyer can untick it', async () => {
  const p = await load(cfg(FOUNDING));
  p.period('month');
  assert.equal(p.$('founding').hidden, false); // the banner stays; the option is yearly only
  assert.equal(p.$('founding-opt').hidden, true);
  assert.equal(p.$('team-price').textContent, '$20');
  assert.equal('discountId' in await p.buy(), false);
  assert.deepEqual(p.opened.at(-1).items, [{ priceId: 'pri_tm', quantity: 5 }]);

  p.period('year');
  p.$('founding-on').click();
  assert.equal(p.$('team-price').textContent, '$16');
  assert.equal(p.$('total').textContent, '$960 a year');
  assert.equal('discountId' in await p.buy(), false);
  p.$('founding-on').click();
  assert.equal((await p.buy()).discountId, 'dsc_01test');
});

test('extra machines are not discounted', async () => {
  const { $ } = await load(cfg(FOUNDING));
  $('machines').value = '2';
  $('machines').fire('input');
  assert.equal($('total').textContent, '$1,488 a year'); // 5 × $12 × 12 + 2 × $384
});

test('the founding price is for teams of up to 20 people; above that a short line, and no discount', async () => {
  const p = await load(cfg(FOUNDING));
  const people = n => { p.$('seats').value = String(n); p.$('seats').fire('input'); };
  people(20);
  assert.equal(p.$('founding-opt').hidden, false);
  assert.equal(p.$('founding-cap').hidden, true);
  assert.equal(p.$('team-price').textContent, '$12');
  assert.equal(p.$('total').textContent, '$2,880 a year'); // 20 × $12 × 12
  assert.equal((await p.buy()).discountId, 'dsc_01test');

  people(21);
  assert.equal(p.$('founding-opt').hidden, true);
  assert.equal(p.$('founding-cap').hidden, false);
  assert.equal(p.$('founding').hidden, false); // the banner still shows
  assert.equal(p.$('team-price').textContent, '$16');
  assert.equal(p.$('total').textContent, '$4,032 a year'); // 21 × $16 × 12
  const opts = await p.buy();
  assert.equal('discountId' in opts, false);
  assert.deepEqual(opts.items, [{ priceId: 'pri_ty', quantity: 21 }]);
  assert.ok(HTML.includes('>The founding price is for teams of up to 20 people</p>'));

  // Monthly: neither the option nor the line (founding is yearly only anyway).
  p.period('month');
  assert.equal(p.$('founding-opt').hidden, true);
  assert.equal(p.$('founding-cap').hidden, true);
  // Back to 20 on yearly: offered again, still ticked.
  p.period('year');
  people(20);
  assert.equal(p.$('founding-cap').hidden, true);
  assert.equal((await p.buy()).discountId, 'dsc_01test');

  // Without the offer, the line never shows.
  const none = await load(cfg());
  none.$('seats').value = '30'; none.$('seats').fire('input');
  assert.equal(none.$('founding-cap').hidden, true);
});

test('after the founding price: the Team yearly price at that time, with 60 days’ notice, never a set number', async () => {
  const RENEW = 'then the Team yearly price at that time, with 60 days’ notice';
  const TERMS = readFileSync(new URL('./terms/index.html', import.meta.url), 'utf8');
  const MANUAL = readFileSync(new URL('../docs/manual.md', import.meta.url), 'utf8');
  for (const [name, text] of [['pricing', HTML], ['pricing.js', JS], ['terms', TERMS], ['manual', MANUAL]]) {
    assert.doesNotMatch(text, /then \$\d+/, name);
    assert.doesNotMatch(text, /normal (Team )?yearly price/, name);
  }
  const card = HTML.slice(HTML.indexOf('id="founding-opt"'), HTML.indexOf('</label>', HTML.indexOf('id="founding-opt"')));
  assert.ok(card.includes(RENEW), 'the Team card');
  const banner = HTML.slice(HTML.indexOf('class="founding-sub"'), HTML.indexOf('</p>', HTML.indexOf('class="founding-sub"')));
  assert.ok(banner.includes(RENEW), 'the banner');
  assert.ok(TERMS.includes("the Team yearly price at that time, with 60 days' notice"), 'the terms');
  const { $ } = await load(cfg(FOUNDING));
  assert.equal($('team-alt').textContent, 'Founding price, then the Team yearly price at that time, with 60 days’ notice. $20 month to month.');
});

test('a machine licence is one test run at a time, on the pricing page and in the terms', () => {
  const RULE = 'A machine licence covers one test run at a time on any machine; a pipeline running N jobs in parallel needs N licences.';
  const TERMS = readFileSync(new URL('./terms/index.html', import.meta.url), 'utf8');
  assert.ok(HTML.includes(RULE), 'pricing');
  assert.ok(TERMS.includes(RULE), 'terms');
  assert.ok(HTML.includes('1 machine licence: one test run at a time'), 'the Team card');
});

test('when the count can’t be had, the offer shows as "25 places", with no number', async () => {
  for (const answer of ['offline', 503, 429, { ok: false }, { total: '25', taken: 3 }, { total: 25, taken: -1 }]) {
    const { $, buy } = await load(cfg(FOUNDING), answer);
    assert.equal($('founding').hidden, false, JSON.stringify(answer));
    assert.equal($('founding-title').textContent, TITLE + '25 places');
    assert.equal($('team-price').textContent, '$12');
    assert.equal((await buy()).discountId, 'dsc_01test');
  }
  // No places URL in the config: the same.
  const { $ } = await load({ ...cfg(FOUNDING), foundingPlacesUrl: '' });
  assert.equal($('founding-title').textContent, TITLE + '25 places');
});

test('all places taken: nothing shows and checkout has no discount', async () => {
  for (const places of [{ total: 25, taken: 25 }, { total: 25, taken: 26 }]) {
    const { $, buy } = await load(cfg(FOUNDING), places);
    assert.equal($('founding').hidden, true);
    assert.equal($('founding-opt').hidden, true);
    assert.equal($('team-price').textContent, '$16');
    assert.equal('discountId' in await buy(), false);
  }
  const last = await load(cfg(FOUNDING), { total: 25, taken: 24 });
  assert.equal(last.$('founding-title').textContent, TITLE + '1 of 25 places left');
});

test('the Business card: $30 billed yearly, 20 people, what it adds, and Contact us', () => {
  const card = HTML.slice(HTML.indexOf('<h2>Business</h2>'), HTML.indexOf('</article>', HTML.indexOf('<h2>Business</h2>')));
  for (const s of ['20 people or more', '$30', 'per person per month, billed yearly', '$360 per person per year', 'Everything in Team',
    '5 machine licences included', 'Choose another AI model', 'Support answered within 4 business hours', 'Invoice billing']) assert.ok(card.includes(s), s);
  assert.ok(card.includes('href="mailto:support@breakpatch.dev?subject=Breakpatch%20Business">Contact us</a>'));
});

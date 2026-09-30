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
 * Loads the page with this Paddle config. `places` is what GET /api/founding answers, and `domains`
 * what GET /api/solo-domain answers: a body, a status number, or 'offline'. Returns the elements,
 * Paddle's checkout calls and the fetches.
 */
async function load(config, places = { total: 25, taken: 0 }, domains = { taken: false }, search = '') {
  const { byId, all } = parse(HTML);
  const opened = [], fetched = [];
  const answer = a => {
    if (a === 'offline') throw new TypeError('Failed to fetch');
    if (typeof a === 'number') return { ok: false, status: a, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => structuredClone(a) };
  };
  const window = {
    BREAKPATCH_PADDLE: config,
    matchMedia: () => ({ matches: false }),
    fetch: async (url, init) => {
      fetched.push({ url, credentials: init?.credentials });
      return answer(url.startsWith(SOLO_URL) ? domains : places);
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
          Initialize(opts) { window.paddleInit = opts; },
          Checkout: { open: opts => opened.push(plain(opts)) },
        };
        s.onload();
      },
    },
  };
  const location = { href: 'https://breakpatch.dev/pricing/', search };
  const ctx = vm.createContext({ window, document, location, URL, setTimeout, clearTimeout, AbortController });
  vm.runInContext(JS, ctx);
  await new Promise(r => setImmediate(r)); // the places answer
  const $ = id => byId[id];
  const buy = async () => { $('team-form').fire('submit'); await new Promise(r => setImmediate(r)); return opened.at(-1); };
  const period = p => all.find(e => e.dataset.period === p).click();
  const soloPeriod = p => all.find(e => e.dataset.soloPeriod === p).click();
  /** Presses Buy Solo; the domain check and Paddle.js take a few turns. Returns the checkout opened, if any. */
  const buySolo = async () => {
    const before = opened.length;
    $('solo-form').fire('submit');
    for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0));
    return opened.length > before ? opened.at(-1) : undefined;
  };
  return { $, buy, period, soloPeriod, buySolo, opened, fetched, location, window };
}

const prices = { soloMonthly: 'pri_sm', soloYearly: 'pri_sy', teamMonthly: 'pri_tm', teamYearly: 'pri_ty', machineMonthly: 'pri_mm', machineYearly: 'pri_my' };
const URL_ = 'https://account.breakpatch.dev/api/founding';
const SOLO_URL = 'https://account.breakpatch.dev/api/solo-domain';
const cfg = (extra = {}) => ({ env: 'sandbox', foundingPlacesUrl: URL_, soloDomainUrl: SOLO_URL, sandbox: { clientToken: 'test_x', prices, ...extra }, live: { prices: {} } });
const FOUNDING = { foundingDiscountId: 'dsc_01test' };
const TITLE = 'Founding teams: $12/person/month for 24 months · ';

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

test('checkout off: the free beta, no Work email or Company, no tax line, and an email that says what was picked', async () => {
  const off = { env: 'sandbox', foundingPlacesUrl: URL_, soloDomainUrl: SOLO_URL, sandbox: { clientToken: '', prices: {} }, live: { prices: {} } };
  const p = await load(off);
  assert.equal(p.$('buyer').hidden, true);
  assert.equal(p.$('buy').textContent, 'Join the free beta');
  assert.equal(p.$('buy-note').hidden, false);
  assert.doesNotMatch(p.$('total-sub').textContent, /Tax/);
  p.$('seats').value = '7'; p.$('seats').fire('input');
  p.period('month');
  assert.equal(await p.buy(), undefined); // no Paddle checkout
  const mail = p.location.href;
  assert.ok(mail.startsWith('mailto:support@breakpatch.dev?subject=Breakpatch%20Team%20beta&body='), mail);
  const body = decodeURIComponent(mail.slice(mail.indexOf('&body=') + 6));
  assert.match(body, /People: 7\n/);
  assert.match(body, /Extra machine licences: 0\n/);
  assert.match(body, /Billing: monthly\n/);
  // The page as served (before the script runs) has the fields hidden and no tax line either.
  assert.match(HTML, /<div class="fields buyer" id="buyer" hidden>/);
  assert.doesNotMatch(HTML, /Tax is added at checkout/);
});

test('checkout on: Work email and Company show, and the tax line is back', async () => {
  const { $ } = await load(cfg());
  assert.equal($('buyer').hidden, false);
  assert.equal($('buy').textContent, 'Buy Team');
  assert.equal($('buy-note').hidden, true);
  assert.equal($('total-sub').textContent, '5 people, 1 machine licence (1 included). Tax is added at checkout.');
});

// ---------- Solo ----------

const soloCard = () => HTML.slice(HTML.indexOf('class="edition plan-solo"'), HTML.indexOf('</article>', HTML.indexOf('class="edition plan-solo"')));

test('the Solo card: $16 a month billed yearly or $19 monthly, one person, one per company, Team for more', async () => {
  const card = soloCard();
  for (const s of ['<h2 id="solo-title">Solo</h2>', '1 person', 'Fixed automatically', 'Schedules on your Mac, with notifications and result messages',
    'The CI command line, with 1 machine licence: one test run at a time', 'Your tests stay in your folder or in Git. Connecting your own workspace is optional',
    'one Solo per company', 'For more people, choose Team']) assert.ok(card.includes(s), s);
  // Between Community and Team.
  assert.ok(HTML.indexOf('plan-solo') > HTML.indexOf('<h2>Community</h2>') && HTML.indexOf('plan-solo') < HTML.indexOf('plan-team'));
  const p = await load(cfg());
  assert.equal(p.$('solo-price').textContent, '$16');
  assert.equal(p.$('solo-per').textContent, 'per month, billed yearly');
  assert.equal(p.$('solo-alt').textContent, '$19 month to month. Save $36 a year.');
  assert.equal(p.$('solo-total').textContent, '$192 a year');
  assert.equal(p.$('solo-total-sub').textContent, '1 person, 1 machine licence. Tax is added at checkout.');
  p.soloPeriod('month');
  assert.equal(p.$('solo-price').textContent, '$19');
  assert.equal(p.$('solo-per').textContent, 'per month');
  assert.equal(p.$('solo-total').textContent, '$19 a month');
  // Solo's period doesn't move Team's, and the other way round.
  assert.equal(p.$('team-price').textContent, '$16');
  p.period('month');
  assert.equal(p.$('solo-price').textContent, '$19');
  p.soloPeriod('year');
  assert.equal(p.$('team-price').textContent, '$20');
  assert.equal(p.$('solo-price').textContent, '$16');
});

test('Buy Solo: asks about the email’s domain only, then opens checkout for one Solo seat', async () => {
  const p = await load(cfg());
  assert.equal(p.$('solo-buyer').hidden, false);
  assert.equal(p.$('solo-buy').textContent, 'Buy Solo');
  p.$('solo-email').value = ' Sam@Initech.com ';
  const opts = await p.buySolo();
  assert.deepEqual(plain(p.fetched), [{ url: SOLO_URL + '?domain=initech.com', credentials: 'omit' }]);
  assert.ok(!p.fetched.some(f => f.url.includes('sam')), 'never the address');
  assert.deepEqual(opts.items, [{ priceId: 'pri_sy', quantity: 1 }]);
  assert.deepEqual(opts.customer, { email: 'sam@initech.com' });
  assert.deepEqual(opts.customData, { company: '', email: 'sam@initech.com' });
  assert.equal('discountId' in opts, false); // no founding price for Solo
  p.soloPeriod('month');
  assert.deepEqual((await p.buySolo()).items, [{ priceId: 'pri_sm', quantity: 1 }]);
  assert.equal(p.$('solo-taken').hidden, true);
});

test('a company that already has Solo is shown Team, with no checkout', async () => {
  const p = await load(cfg(), undefined, { domain: 'initech.com', taken: true, personal: false });
  p.$('solo-email').value = 'lee@initech.com';
  assert.equal(await p.buySolo(), undefined);
  assert.equal(p.$('solo-taken').hidden, false);
  assert.equal(p.$('solo-taken-domain').textContent, 'initech.com');
  assert.ok(HTML.includes('already has Breakpatch Solo. Solo is one per company, so <a href="#team-title">Team</a> is the plan for more people there.'));
  // Typing another email hides it again.
  p.$('solo-email').value = 'lee@elsewhere.com';
  p.$('solo-email').fire('input');
  assert.equal(p.$('solo-taken').hidden, true);
});

test('when the domain check can’t answer, checkout goes ahead (the back office checks again)', async () => {
  for (const answer of ['offline', 503, 429, { ok: false }, { taken: 'yes' }]) {
    const p = await load(cfg(), undefined, answer);
    p.$('solo-email').value = 'sam@initech.com';
    const opts = await p.buySolo();
    assert.deepEqual(opts?.items, [{ priceId: 'pri_sy', quantity: 1 }], JSON.stringify(answer));
    assert.equal(p.$('solo-taken').hidden, true);
  }
  // No URL in the config: no check at all.
  const p = await load({ ...cfg(), soloDomainUrl: '' });
  p.$('solo-email').value = 'sam@initech.com';
  assert.ok(await p.buySolo());
  assert.equal(p.fetched.length, 0);
});

test('Solo checkout off (no Solo prices yet): the free beta, no email field, no tax line', async () => {
  const noSolo = { ...prices, soloMonthly: '', soloYearly: '' };
  const p = await load({ ...cfg(), sandbox: { clientToken: 'test_x', prices: noSolo } });
  assert.equal(p.$('solo-buyer').hidden, true);
  assert.equal(p.$('solo-buy').textContent, 'Join the free beta');
  assert.equal(p.$('solo-buy-note').hidden, false);
  assert.equal(p.$('solo-total-sub').textContent, '1 person, 1 machine licence.');
  assert.equal(await p.buySolo(), undefined);
  assert.ok(p.location.href.startsWith('mailto:support@breakpatch.dev?subject=Breakpatch%20Solo%20beta&body='), p.location.href);
  assert.equal(p.fetched.length, 0);
  // Team still sells meanwhile.
  assert.equal(p.$('buy').textContent, 'Buy Team');
  assert.match(HTML, /<div class="fields buyer" id="solo-buyer" hidden>/);
});

test('Solo in the page description, the FAQ, the terms, the refunds and the manual', () => {
  const TERMS = readFileSync(new URL('./terms/index.html', import.meta.url), 'utf8');
  const REFUNDS = readFileSync(new URL('./refunds/index.html', import.meta.url), 'utf8');
  const MANUAL = readFileSync(new URL('../docs/manual.md', import.meta.url), 'utf8');
  const HOME = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(HTML, /<meta name="description" content="[^"]*Solo is \$16 a month billed yearly, or \$19 month to month, for one person/);
  assert.ok(HTML.includes('<dt>Who is Solo for?</dt>'));
  assert.ok(TERMS.includes('Breakpatch Solo, Team and Business licences'), 'terms: what they cover');
  assert.ok(TERMS.includes('one Solo per company'), 'terms: the Solo rule');
  assert.ok(REFUNDS.includes('Breakpatch Solo, Team and Business'), 'refunds');
  assert.match(MANUAL, /\| *Solo *\|/, 'manual editions');
  assert.ok(HOME.includes('<th scope="col">Solo</th>'), 'home comparison table');
  // The same prices everywhere.
  for (const [name, text] of [['home', HOME], ['manual', MANUAL]]) assert.match(text, /\$19/, name);
});

test('a personal email is still sent only as its domain, and gets a checkout (the service never looks those up)', async () => {
  const p = await load(cfg(), undefined, { domain: 'gmail.com', taken: false, personal: true });
  p.$('solo-email').value = 'sam.smith@gmail.com';
  const opts = await p.buySolo();
  assert.deepEqual(plain(p.fetched), [{ url: SOLO_URL + '?domain=gmail.com', credentials: 'omit' }]);
  assert.deepEqual(opts.customer, { email: 'sam.smith@gmail.com' });
});

test('the domain is asked when the email field loses focus, so Buy doesn’t wait, and only once', async () => {
  const p = await load(cfg());
  p.$('solo-email').value = 'sam@initech.com';
  p.$('solo-email').fire('blur');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(p.fetched.length, 1);
  assert.ok(await p.buySolo());
  assert.equal(p.fetched.length, 1); // Buy reused the answer
  // Another email: asked again. Not an email yet: nothing asked.
  p.$('solo-email').value = 'sam@hooli.com'; p.$('solo-email').fire('blur');
  p.$('solo-email').value = 'sam'; p.$('solo-email').fire('blur');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(p.fetched.map(f => f.url), [SOLO_URL + '?domain=initech.com', SOLO_URL + '?domain=hooli.com']);
  // With the checkout off, focus alone asks nothing.
  const off = await load({ ...cfg(), sandbox: { clientToken: '', prices } });
  off.$('solo-email').value = 'sam@initech.com'; off.$('solo-email').fire('blur');
  await new Promise(r => setTimeout(r, 0));
  assert.equal(off.fetched.length, 0);
});

test('a check that failed is asked again on Buy', async () => {
  const p = await load(cfg(), undefined, 503);
  p.$('solo-email').value = 'sam@initech.com';
  p.$('solo-email').fire('blur');
  for (let i = 0; i < 3; i++) await new Promise(r => setTimeout(r, 0));
  assert.ok(await p.buySolo());
  assert.equal(p.fetched.length, 2);
});

test('a Paddle payment link (?_ptxn=) that fails shows the error on the Team card', async () => {
  const p = await load(cfg(), undefined, undefined, '?_ptxn=txn_01test');
  await new Promise(r => setTimeout(r, 0));
  assert.ok(p.window.paddleInit, 'Paddle.js was initialized for the payment link');
  assert.equal(p.$('buy-error').hidden, true);
  p.window.paddleInit.eventCallback({ name: 'checkout.error' });
  assert.equal(p.$('buy-error').hidden, false);
  assert.equal(p.$('buy-error').textContent, 'The checkout couldn’t continue. Try again, or email support@breakpatch.dev.');
});

test('one test run at a time is per Mac or machine licence: nothing promises it across a Solo licence', () => {
  const MANUAL = readFileSync(new URL('../docs/manual.md', import.meta.url), 'utf8');
  const TERMS = readFileSync(new URL('./terms/index.html', import.meta.url), 'utf8');
  for (const [name, text] of [['pricing', HTML], ['manual', MANUAL], ['terms', TERMS]]) {
    assert.doesNotMatch(text, /across the licence|one test at a time, on your Mac or on the machine licence/i, name);
  }
  assert.ok(MANUAL.includes('Your Mac and the machine licence each run one test at a time.'));
  const PRIVACY = readFileSync(new URL('./privacy/index.html', import.meta.url), 'utf8');
  assert.ok(PRIVACY.includes('The answer is only whether that company domain already has a Solo'), 'privacy: what the check answers');
});

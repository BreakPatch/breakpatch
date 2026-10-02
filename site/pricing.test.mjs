// Checks /pricing's plan picker (assets/pricing.js) against the real pricing/index.html, with a
// tiny DOM stand-in and Paddle.js stubbed: no browser, nothing to install.
//   node --test site/pricing.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const HTML = read('./pricing/index.html');
const JS = read('./assets/pricing.js');
const GET_JSON = read('./assets/get-json.js');
const CONFIG = read('./assets/paddle-config.js');

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
async function load(config, places = { total: 25, taken: 0 }, domains = { taken: false }, search = '', setUp = () => {}) {
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
  setUp(window);
  const ctx = vm.createContext({ window, document, location, URL, setTimeout, clearTimeout, AbortController });
  vm.runInContext(GET_JSON, ctx);
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
// Solo on sale, as on launch day; the tests below "Solo not on sale yet" turn it off.
const cfg = (extra = {}) => ({ env: 'sandbox', soloOnSale: true, foundingPlacesUrl: URL_, soloDomainUrl: SOLO_URL, sandbox: { clientToken: 'test_x', prices, ...extra }, live: { prices: {} } });
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
    '5 machine licences included', 'Choose another AI model', 'Support answered within 4 business hours, Monday to Friday', 'Invoice billing']) assert.ok(card.includes(s), s);
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

const soloCard = () => HTML.slice(HTML.indexOf('class="edition plan-solo'), HTML.indexOf('</article>', HTML.indexOf('class="edition plan-solo')));

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

test('a company that has Team or Business is told to ask its admin for a seat, with no checkout', async () => {
  // The back office answers for the company: a subdomain's email is counted as it.
  const p = await load(cfg(), undefined, { domain: 'initech.com', taken: true, takenBy: 'team', personal: false });
  p.$('solo-email').value = 'lee@eng.initech.com';
  assert.equal(await p.buySolo(), undefined);
  assert.deepEqual(plain(p.fetched), [{ url: SOLO_URL + '?domain=eng.initech.com', credentials: 'omit' }]);
  assert.equal(p.$('solo-team').hidden, false);
  assert.equal(p.$('solo-taken').hidden, true);
  assert.equal(p.$('solo-team-domain').textContent, 'initech.com');
  assert.ok(HTML.includes("already uses Breakpatch Team or Business, so ask its admin for a seat there. Solo is for companies that don't use Breakpatch yet."));
  p.$('solo-email').value = 'lee@elsewhere.com';
  p.$('solo-email').fire('input');
  assert.equal(p.$('solo-team').hidden, true);
  // A second Solo at a subdomain names the company too.
  const q = await load(cfg(), undefined, { domain: 'initech.com', taken: true, takenBy: 'solo', personal: false });
  q.$('solo-email').value = 'kim@eu.initech.com';
  assert.equal(await q.buySolo(), undefined);
  assert.equal(q.$('solo-taken-domain').textContent, 'initech.com');
  assert.equal(q.$('solo-team').hidden, true);
});

test('support response times are the same on the pricing page and the terms; the documentation promises none yet', () => {
  const terms = read('./terms/index.html');
  const manual = read('../docs/manual.md');
  const card = name => HTML.slice(HTML.indexOf(`id="${name}-title"`), HTML.indexOf('</article>', HTML.indexOf(`id="${name}-title"`)));
  assert.ok(card('solo').includes('Email support, answered within 5 business days'));
  assert.ok(card('team').includes('Email support, answered within 2 business days'));
  const biz = HTML.slice(HTML.indexOf('<h2>Business</h2>'), HTML.indexOf('</article>', HTML.indexOf('<h2>Business</h2>')));
  assert.ok(biz.includes('Support answered within 4 business hours, Monday to Friday'));
  assert.ok(terms.includes('Solo: email support, answered within 5 business days. Team: email support, answered within 2 business days. Business: support answered within 4 business hours, Monday to Friday.'));
  // Team and Business aren't on sale yet: the documentation leaves their support to the pricing page.
  assert.ok(manual.includes('| Support | GitHub issues | Set when it goes on sale | Set when they go on sale |'));
  assert.doesNotMatch(manual, /business (days|hours)/);
  for (const page of [HTML, terms, manual]) assert.ok(!/Solo and Team: email support/.test(page));
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

test('Solo in the FAQ, the terms, the refunds and the manual', () => {
  const TERMS = readFileSync(new URL('./terms/index.html', import.meta.url), 'utf8');
  const REFUNDS = readFileSync(new URL('./refunds/index.html', import.meta.url), 'utf8');
  const MANUAL = readFileSync(new URL('../docs/manual.md', import.meta.url), 'utf8');
  const HOME = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  // The description can't follow the switch (search engines read it as served), so it leaves Solo out.
  assert.doesNotMatch(HTML.match(/<meta name="description" content="([^"]*)"/)[1], /Solo/);
  assert.ok(HTML.includes('<dt class="solo-only">Who is Solo for?</dt>'));
  assert.ok(TERMS.includes('Breakpatch Team and Business licences bought on breakpatch.dev, and Solo licences when the Solo plan is offered'), 'terms: what they cover');
  assert.ok(TERMS.includes('one Solo per company'), 'terms: the Solo rule');
  assert.ok(REFUNDS.includes('Breakpatch Team and Business, and the Solo plan when it’s offered'), 'refunds');
  assert.match(MANUAL, /\| *Solo *\|/, 'manual editions');
  assert.ok(HOME.includes('<th scope="col" class="solo-only">Solo</th>'), 'home comparison table');
  // The same prices everywhere.
  assert.match(HOME, /\$19/, 'home');
  // The documentation names no prices while Solo, Team and Business aren't on sale.
  assert.doesNotMatch(MANUAL, /\$\d/, 'manual');
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
  assert.ok(PRIVACY.includes('The answer is only whether that company already has Solo, or Team or Business (without saying which of the two, or who)'), 'privacy: what the check answers');
});

// ---------- Solo not on sale yet (paddle-config.js soloOnSale: false) ----------

/** The page's HTML with every element of `cls` taken out (what a browser shows when site.css hides it). */
function without(html, cls) {
  const open = new RegExp(`<([a-z0-9]+)\\b[^>]*\\bclass="[^"]*\\b${cls}\\b[^"]*"[^>]*>`, 'i');
  for (let m; (m = open.exec(html));) {
    const tag = m[1];
    const re = new RegExp(`<${tag}\\b[^>]*>|</${tag}>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1, end = -1;
    for (let t; depth && (t = re.exec(html));) { depth += t[0][1] === '/' ? -1 : 1; if (!depth) end = t.index + t[0].length; }
    assert.ok(end > 0, `unclosed <${tag}> with ${cls}`);
    html = html.slice(0, m.index) + html.slice(end);
  }
  return html;
}
/** What a visitor can read or follow: text and links, without comments, scripts, styles or <head>. */
const visible = html => html.replace(/<head>[\s\S]*?<\/head>/, '').replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
const HOME = read('./index.html');
const MANUAL_PAGE = read('./docs/index.html');
const SITE_CSS = read('./assets/site.css');
const PRICING_CSS = read('./assets/pricing.css');

test('Solo is on sale when the back office says so: /api/solo-domain answers (404 until its switch is on)', async () => {
  // No switch of its own to flip: soloOnSale starts false and comes from the back office's answer.
  assert.match(CONFIG, /\n  soloOnSale: false,\n/);
  const run = async (answer, stored = null) => {
    const attrs = {}, events = [], store = new Map(stored === null ? [] : [['breakpatch.soloOnSale', stored]]), asked = [];
    const window = {
      fetch: async url => { asked.push(url); if (answer === 'offline') throw new TypeError('Failed to fetch'); return { ok: answer === 200, status: answer }; },
      localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) },
      Event: class { constructor(type) { this.type = type; } },
      dispatchEvent: e => events.push(e.type),
    };
    const ctx = vm.createContext({ window, document: { documentElement: { setAttribute(k, v) { attrs[k] = v; }, removeAttribute(k) { delete attrs[k]; } } } });
    vm.runInContext(CONFIG, ctx);
    const before = 'data-solo' in attrs;
    await new Promise(r => setImmediate(r));
    return { before, after: 'data-solo' in attrs, on: window.BREAKPATCH_PADDLE.soloOnSale, stored: store.get('breakpatch.soloOnSale'), events, asked };
  };
  const off = await run(404);
  assert.deepEqual([off.before, off.after, off.on, off.stored, off.events], [false, false, false, '0', []]);
  assert.match(off.asked[0], /^https:\/\/account\.breakpatch\.dev\/api\/solo-domain\?domain=/);
  const on = await run(200);
  assert.deepEqual([on.before, on.after, on.on, on.stored, on.events], [false, true, true, '1', ['breakpatch-solo']]);
  // The last answer on this browser is there before the first paint, then the new one wins.
  const seen = await run(200, '1');
  assert.deepEqual([seen.before, seen.after, seen.events], [true, true, []]);
  const withdrawn = await run(404, '1');
  assert.deepEqual([withdrawn.before, withdrawn.after, withdrawn.stored], [true, false, '0']);
  // Offline, or the back office had a problem: as last time.
  for (const a of ['offline', 500]) {
    const r = await run(a, '1');
    assert.deepEqual([r.after, r.stored], [true, '1'], String(a));
  }
  // Loaded in <head> (before the page is drawn), and no page has data-solo as served.
  for (const [name, page] of [['home', HOME], ['pricing', HTML], ['manual', MANUAL_PAGE]]) {
    const head = page.slice(0, page.indexOf('</head>'));
    assert.match(head, /<script src="(\.\.)?\/assets\/paddle-config\.js"><\/script>/, name);
    assert.doesNotMatch(page.match(/<html[^>]*>/)[0], /data-solo/, name);
  }
  assert.ok(SITE_CSS.includes('html:not([data-solo]) .solo-only,[data-solo] .solo-off{display:none!important}'));
});

test('a Solo answer that comes after Pricing started sets up the card then', async () => {
  const config = { ...cfg(), soloOnSale: false };
  const listeners = {};
  const p = await load(config, undefined, { taken: false }, '', w => {
    w.addEventListener = (t, f) => { (listeners[t] ??= []).push(f); };
    w.removeEventListener = (t, f) => { listeners[t] = (listeners[t] ?? []).filter(x => x !== f); };
  });
  assert.equal(await p.buySolo(), undefined, 'not yet');
  config.soloOnSale = true;
  for (const f of listeners['breakpatch-solo'] ?? []) f();
  assert.equal(p.$('solo-buy').textContent, 'Buy Solo');
});
test('while Solo is off: no Solo card, words or links on Pricing, and no gap where the card was', () => {
  const page = visible(without(HTML, 'solo-only'));
  assert.doesNotMatch(page, /Solo/);
  assert.doesNotMatch(page, /solo-/, 'nothing points at the Solo card');
  // Three cards, in the three-column grid (and two columns on smaller screens, with Team across the top).
  assert.equal((page.match(/<article class="edition/g) ?? []).length, 3);
  assert.match(PRICING_CSS, /\.plans\{display:grid;grid-template-columns:1fr 1\.4fr 1fr;/);
  assert.ok(PRICING_CSS.includes(':where([data-solo]) .plans{grid-template-columns:1fr 1.1fr 1.4fr 1fr}'));
  assert.ok(PRICING_CSS.includes('@media (max-width:1000px){.plans{grid-template-columns:1fr 1fr}.plan-team{grid-column:1 / -1;order:-1}}'));
  // The sentences still read: "Free on your own Mac. Pay per person …".
  assert.ok(page.includes('<p>Free on your own Mac. Pay per person when your team tests together'));
  assert.ok(page.includes('Your key is shown there once. On Team, a workspace admin'));
  // And with Solo on, everything is there.
  const on = visible(without(HTML, 'solo-off'));
  for (const s of ['<h2 id="solo-title">Solo</h2>', 'Who is Solo for?', ' Solo when you want the automation for yourself.', ' On Solo, enter it in Breakpatch']) assert.ok(on.includes(s), s);
  assert.equal((on.match(/<article class="edition/g) ?? []).length, 4);
});

test('while Solo is off: Home has no Solo card or column, and no gap', () => {
  const page = visible(without(HOME, 'solo-only'));
  assert.doesNotMatch(page, /Solo/);
  const compare = page.slice(page.indexOf('<div class="compare">'), page.indexOf('<p class="biz">'));
  assert.equal((compare.match(/<article class="plan/g) ?? []).length, 2);
  assert.ok(SITE_CSS.includes('.compare{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));'));
  assert.ok(SITE_CSS.includes(':where([data-solo]) .compare{grid-template-columns:repeat(3,minmax(0,1fr))}'));
  // Every row of the table: the feature and two columns, Community and Team.
  const matrix = html => html.slice(html.indexOf('<table class="matrix stack">'), html.indexOf('</table>', html.indexOf('<table class="matrix stack">')));
  const rows = [...matrix(page).matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(m => m[1]);
  assert.ok(rows.length >= 10);
  for (const r of rows) {
    assert.equal((r.match(/<t[dh]\b/g) ?? []).length, 3, r);
    assert.doesNotMatch(r, /data-label="Solo"/);
  }
  assert.ok(page.includes('<caption>Community and Team side by side</caption>'));
  assert.ok(page.includes('for one person on one Mac. Team shares everything'));
  assert.ok(page.includes('no time limit and no account. Team is paid'));
  // With Solo on: three plans, and four cells a row.
  const on = visible(without(HOME, 'solo-off'));
  assert.equal((on.slice(on.indexOf('<div class="compare">'), on.indexOf('<p class="biz">')).match(/<article class="plan/g) ?? []).length, 3);
  for (const r of matrix(on).matchAll(/<tr>([\s\S]*?)<\/tr>/g)) assert.equal((r[1].match(/<t[dh]\b/g) ?? []).length, 4);
  assert.ok(on.includes('<caption>Community<span class="solo-only">, Solo</span> and Team side by side</caption>'));
});

test('while Solo is off: pricing.js leaves the card alone and never asks about a domain', async () => {
  for (const soloOnSale of [false, undefined, 'true']) {
    const p = await load({ ...cfg(), soloOnSale });
    p.$('solo-email').value = 'sam@initech.com';
    p.$('solo-email').fire('blur');
    assert.equal(await p.buySolo(), undefined, String(soloOnSale));
    assert.equal(p.fetched.length, 0, 'no domain check');
    assert.equal(p.location.href, 'https://breakpatch.dev/pricing/', 'no beta email either');
    assert.equal(p.$('solo-price').textContent, '', 'the card isn’t set up');
    // Team sells as usual.
    assert.equal(p.$('buy').textContent, 'Buy Team');
    assert.deepEqual((await p.buy()).items, [{ priceId: 'pri_ty', quantity: 5 }]);
  }
});

test('the terms, refunds and privacy pages read right while Solo is off: "when offered", and no link to it', () => {
  const TERMS = read('./terms/index.html'), REFUNDS = read('./refunds/index.html'), PRIVACY = read('./privacy/index.html');
  assert.ok(TERMS.includes('<li><b>Solo</b>, when offered, is for one person'));
  assert.ok(REFUNDS.includes('<p>The Solo plan, when offered, is one per company.'));
  assert.ok(PRIVACY.includes('<p>When the Solo plan is offered: before its checkout opens, the pricing page sends'));
  assert.ok(PRIVACY.includes('<th scope="row">Breakpatch Team, and Solo when offered</th>'));
  for (const [name, text] of [['terms', TERMS], ['refunds', REFUNDS], ['privacy', PRIVACY]]) {
    assert.doesNotMatch(text, /href="[^"]*solo/i, name);
    assert.doesNotMatch(text, /Breakpatch Solo, Team/, name);
  }
});

test('the manual keeps its Solo section, marked Coming soon until Solo is on sale', () => {
  const MANUAL = read('../docs/manual.md');
  const section = MANUAL.slice(MANUAL.indexOf('## Solo\n'), MANUAL.indexOf('## Upgrading to Team'));
  assert.match(section, /^## Solo\n\n<!-- solo-soon --> Coming soon\. Solo isn't on sale yet\./);
  const built = MANUAL_PAGE.slice(MANUAL_PAGE.indexOf('<section id="solo"'), MANUAL_PAGE.indexOf('</section>', MANUAL_PAGE.indexOf('<section id="solo"')));
  assert.match(built, /<p class="solo-soon" role="note"><span class="dot" aria-hidden="true"><\/span><span>Coming soon\. Solo isn't on sale yet\./);
  // Shown while <html> has no data-solo, in the pre-launch notes' style.
  assert.ok(SITE_CSS.includes('[data-prelaunch] .prelaunch,html:not([data-solo]) .solo-soon,.soon{display:flex;'));
  assert.ok(SITE_CSS.includes('.prelaunch,.solo-soon{display:none}'));
});

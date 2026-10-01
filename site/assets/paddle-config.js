// Paddle Billing checkout on /pricing (assets/pricing.js). Paste the ids here; none of them is a
// secret. The client-side token (test_… in sandbox, live_… in live) is made for the browser:
// Paddle → Developer tools → Authentication → Client-side tokens. The price ids are in
// Paddle → Catalog → Products → the product → the price's ⋯ → Copy ID.
//
// `env` picks which set the site uses. Keep 'sandbox' until the live account is approved and the
// live ids below are filled in. The back office has its own copy of the price ids
// (breakpatch-team: backoffice/functions/src/paddle/config.ts), so it knows what each item buys.
//
// Founding price (optional; back office README, "Founding price"): `foundingDiscountId` is the
// Paddle discount's id (dsc_…: 25% off Team yearly, 2 billing periods, usage limit 25). While it's
// set, /pricing shows the founding banner with the places left (from `foundingPlacesUrl`, the back
// office's GET /api/founding) and applies the discount to Team yearly for 20 people or fewer
// (Paddle can't cap the quantity, so the page does, and the webhook); when all 25 are taken, it
// hides them. Leave it '' and nothing shows.
//
// Solo (one person, one per company email domain) is on sale when the back office says so: its
// GET /api/solo-domain (`soloDomainUrl`) answers 404 until its SOLO_ON_SALE switch is on, so the
// site has no switch of its own to flip with it. The bottom of this file asks once per page and
// sets `soloOnSale` and <html data-solo>, remembering the last answer on this browser so a later
// visit is drawn right at once. Until then the site doesn't show Solo at all: no card on /pricing,
// no card or column on the home page, no domain check, and the manual's Solo section says "Coming
// soon" (site.css `.solo-only`, `.solo-off`, `.solo-soon`). `soloMonthly` and `soloYearly` stay '' until the Solo
// prices exist in Paddle; while either is empty for the period picked, the Solo card invites people
// to the beta instead. Before checkout the card asks `soloDomainUrl` (the back office's
// GET /api/solo-domain, sent only the email's domain) whether that company has Solo already, and
// shows Team if it has.
window.BREAKPATCH_PADDLE = {
  env: 'sandbox',
  // Set below from the back office's answer; never by hand.
  soloOnSale: false,
  // Until account.breakpatch.dev is connected: 'https://breakpatch-backoffice.web.app/api/founding'.
  foundingPlacesUrl: 'https://account.breakpatch.dev/api/founding',
  // Until account.breakpatch.dev is connected: 'https://breakpatch-backoffice.web.app/api/solo-domain'.
  soloDomainUrl: 'https://account.breakpatch.dev/api/solo-domain',
  sandbox: {
    clientToken: '',
    prices: {
      soloMonthly: '',     // Solo, $19 per month, quantity 1
      soloYearly: '',      // Solo, $192 per year, quantity 1
      teamMonthly: '',     // Team, $20 per person per month
      teamYearly: '',      // Team, $192 per person per year
      machineMonthly: '',  // Extra machine licence, $40 per month
      machineYearly: '',   // Extra machine licence, $384 per year
    },
    foundingDiscountId: '',  // dsc_…, the founding discount (25% off Team yearly)
  },
  live: {
    clientToken: '',
    prices: {
      soloMonthly: '',
      soloYearly: '',
      teamMonthly: '',
      teamYearly: '',
      machineMonthly: '',
      machineYearly: '',
    },
    foundingDiscountId: '',
  },
};

// Solo on the page: <html data-solo> shows it. This file loads in <head> on the pages that show
// Solo: the last answer on this browser is there before the first paint; the back office's answer
// follows (a "breakpatch-solo" event on window, for pricing.js) and is kept for next time.
(function () {
  var cfg = window.BREAKPATCH_PADDLE, root = document.documentElement, KEY = 'breakpatch.soloOnSale';
  function show(on) {
    cfg.soloOnSale = on;
    if (on) root.setAttribute('data-solo', ''); else if (root.removeAttribute) root.removeAttribute('data-solo');
  }
  try { if (window.localStorage && window.localStorage.getItem(KEY) === '1') show(true); } catch (e) { /* storage off */ }
  var url = typeof cfg.soloDomainUrl === 'string' ? cfg.soloDomainUrl : '';
  if (!url || typeof window.fetch !== 'function') return;
  // Any company domain will do: the answer's status is what counts (404: not on sale).
  window.fetch(url + '?domain=example.com', { headers: { accept: 'application/json' } }).then(function (r) {
    if (r.status !== 404 && !r.ok) return;     // the back office had a problem: as last time
    var on = r.ok;
    try { if (window.localStorage) window.localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* storage off */ }
    if (on !== cfg.soloOnSale) {
      show(on);
      if (typeof window.dispatchEvent === 'function' && typeof window.Event === 'function') window.dispatchEvent(new window.Event('breakpatch-solo'));
    }
  }, function () { /* offline: as last time */ });
})();

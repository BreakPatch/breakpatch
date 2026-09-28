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
window.BREAKPATCH_PADDLE = {
  env: 'sandbox',
  // Until account.breakpatch.dev is connected: 'https://breakpatch-backoffice.web.app/api/founding'.
  foundingPlacesUrl: 'https://account.breakpatch.dev/api/founding',
  sandbox: {
    clientToken: '',
    prices: {
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
      teamMonthly: '',
      teamYearly: '',
      machineMonthly: '',
      machineYearly: '',
    },
    foundingDiscountId: '',
  },
};

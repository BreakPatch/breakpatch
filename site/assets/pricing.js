// /pricing: the Solo plan picker and Paddle Billing's overlay checkout (Paddle.js v2), and Paddle
// payment links. Paddle.js is only loaded when someone presses Buy Solo (or opens a Paddle payment
// link, ?_ptxn=…), so nothing is sent to Paddle by just reading the page. Ids come from
// assets/paddle-config.js.
//
// Team and Business are coming later, with prices to be decided (owner, 2026-10-02): their cards
// have no price and no checkout, so there's nothing for this file to do for them. The Team
// checkout and the founding offer were taken out then; they're in git at 0b3b672 for when Team
// goes on sale (site/README.md, "Team and Business").
(function () {
  'use strict';
  var cfgAll = window.BREAKPATCH_PADDLE || {};
  var env = cfgAll.env === 'live' ? 'live' : 'sandbox';
  var cfg = cfgAll[env] || { prices: {} };
  var $ = function (id) { return document.getElementById(id); };
  var usd = function (n) { return '$' + n.toLocaleString('en-US'); };

  // ---------- Paddle.js ----------

  // GET a JSON answer from the back office, or null (assets/get-json.js, loaded before this file).
  var getJson = typeof window.breakpatchGetJson === 'function' ? window.breakpatchGetJson : function () { return Promise.resolve(null); };

  var loading = null;
  // The card that opened the checkout says what went wrong. Until one has (a Paddle payment link,
  // ?_ptxn=…), the message shows under the page's heading.
  var onCheckoutError = function () {
    var e = $('buy-error');
    if (e) { e.textContent = 'The checkout couldn’t continue. Try again, or email support@breakpatch.dev.'; e.hidden = false; }
  };
  function paddle() {
    if (loading) return loading;
    loading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
      s.onload = function () {
        try {
          if (env === 'sandbox') window.Paddle.Environment.set('sandbox');
          window.Paddle.Initialize({
            token: cfg.clientToken,
            checkout: { settings: settings() },
            eventCallback: function (e) { if (e && e.name === 'checkout.error') onCheckoutError(); },
          });
          resolve(window.Paddle);
        } catch (e) { reject(e); }
      };
      s.onerror = function () { loading = null; reject(new Error('paddle.js did not load')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  function settings() {
    return {
      displayMode: 'overlay',
      theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark',
      locale: 'en',
      successUrl: new URL('../thanks/', location.href).href,
    };
  }

  solo();

  // A Paddle payment link (an invoice or a payment method update Paddle sends people here with):
  // Paddle.js opens that transaction's checkout itself once it's initialized.
  if (/[?&]_ptxn=txn_/.test(location.search) && cfg.clientToken) paddle().catch(function () {});

  // ---------- Solo: one person, one per company ----------

  function solo() {
    var SOLO = { month: 19, year: 16 };            // per month
    var form = $('solo-form');
    // Before Solo is on sale (paddle-config.js asks the back office), its card is hidden (site.css
    // .solo-only) and nothing here runs: no domain check, no checkout. If the answer comes after
    // this page started, the card is set up then.
    if (!form) return;
    if (cfgAll.soloOnSale !== true) {
      if (typeof window.addEventListener === 'function') window.addEventListener('breakpatch-solo', function once() {
        window.removeEventListener('breakpatch-solo', once);
        if (cfgAll.soloOnSale === true) solo();
      });
      return;
    }
    var email = $('solo-email'), buy = $('solo-buy'), note = $('solo-buy-note'), err = $('solo-buy-error'), taken = $('solo-taken'), team = $('solo-team');
    var state = { period: 'year' };

    function priceId() { var p = cfg.prices || {}; return state.period === 'year' ? p.soloYearly : p.soloMonthly; }
    function ready() { return !!(cfg.clientToken && priceId()); }
    function showError(text) { err.textContent = text; err.hidden = !text; }

    function render() {
      var yearly = state.period === 'year';
      document.querySelectorAll('[data-solo-period]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.soloPeriod === state.period)); });
      $('solo-price').textContent = usd(SOLO[state.period]);
      $('solo-per').textContent = yearly ? 'per month, billed yearly' : 'per month';
      $('solo-alt').textContent = yearly ? '$19 month to month. Save $36 a year.' : 'Or $16 per month, billed yearly.';
      var ok = ready();
      $('solo-total').textContent = yearly ? usd(SOLO.year * 12) + ' a year' : usd(SOLO.month) + ' a month';
      $('solo-total-sub').textContent = '1 person, 1 machine licence.' + (ok ? ' Tax is added at checkout.' : '');
      // The email is for Paddle's checkout: while it's off, it's hidden.
      $('solo-buyer').hidden = !ok;
      buy.textContent = ok ? 'Buy Solo' : 'Join the free beta';
      note.hidden = ok;
    }

    /**
     * Whether Solo can be bought for the email's company: GET soloDomainUrl?domain=… (only the
     * domain is sent, never the address) → { domain, taken, takenBy }. `domain` is the company the
     * back office counts it as (eng.acme.com is acme.com). Resolves to { by: 'solo' | 'team',
     * domain } when it can't (another Solo there, or Team or Business), false when it can, and null
     * when it can't say; then checkout goes ahead and the back office checks again.
     */
    // Asked once per domain: when the email field loses focus (so Buy doesn't wait for it), and
    // again on Buy only if the email changed.
    var asked = {};
    function domainTaken(domain) {
      var url = typeof cfgAll.soloDomainUrl === 'string' ? cfgAll.soloDomainUrl : '';
      if (!url || !/^[^\s@]+\.[^\s@]+$/.test(domain)) return Promise.resolve(null);
      if (!asked[domain]) {
        asked[domain] = getJson(url + '?domain=' + encodeURIComponent(domain)).then(function (b) {
          if (!b || typeof b.taken !== 'boolean') return null;
          if (!b.taken) return false;
          return { by: b.takenBy === 'team' ? 'team' : 'solo', domain: typeof b.domain === 'string' && b.domain ? b.domain : domain };
        });
        // A failed check is asked again next time.
        asked[domain].then(function (t) { if (t === null) delete asked[domain]; });
      }
      return asked[domain];
    }
    function domainOf(value) { var who = value.trim().toLowerCase(); return who.slice(who.lastIndexOf('@') + 1); }
    function betaMail() {
      var body = 'Hello,\n\nI would like to join the Breakpatch Solo beta.\n\n'
        + 'Billing: ' + (state.period === 'year' ? 'yearly' : 'monthly') + '\n';
      return 'mailto:support@breakpatch.dev?subject=' + encodeURIComponent('Breakpatch Solo beta') + '&body=' + encodeURIComponent(body);
    }

    document.querySelectorAll('[data-solo-period]').forEach(function (b) {
      b.addEventListener('click', function () { state.period = b.dataset.soloPeriod; render(); });
    });
    email.addEventListener('input', function () { taken.hidden = true; team.hidden = true; });
    email.addEventListener('blur', function () { if (ready()) domainTaken(domainOf(email.value)); });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      showError('');
      taken.hidden = true;
      team.hidden = true;
      if (!ready()) { location.href = betaMail(); return; }
      if (!form.reportValidity()) return;
      var who = email.value.trim().toLowerCase();
      var domain = domainOf(who);
      var id = priceId();
      buy.setAttribute('aria-busy', 'true');
      domainTaken(domain).then(function (has) {
        if (has && has.by === 'team') {
          // The company has Team or Business: the person gets a seat there, not a Solo.
          $('solo-team-domain').textContent = has.domain;
          team.hidden = false;
          return null;
        }
        if (has) {
          // One Solo per company: someone there has it, so Team is the plan for them.
          $('solo-taken-domain').textContent = has.domain;
          taken.hidden = false;
          return null;
        }
        return paddle().then(function (P) {
          onCheckoutError = function () { showError('The checkout couldn’t continue. Try again, or email support@breakpatch.dev.'); };
          P.Checkout.open({
            items: [{ priceId: id, quantity: 1 }],
            customer: { email: who },
            customData: { company: '', email: who },
            settings: settings(),
          });
        });
      }).catch(function () {
        showError('The checkout couldn’t be loaded. Check your connection, or email support@breakpatch.dev.');
      }).finally(function () { buy.removeAttribute('aria-busy'); });
    });

    render();
  }

})();

// /pricing: the Solo and Team plan pickers and Paddle Billing's overlay checkout (Paddle.js v2).
// Paddle.js is only loaded when someone presses Buy (or opens a Paddle payment link, ?_ptxn=…),
// so nothing is sent to Paddle by just reading the page. Ids come from assets/paddle-config.js.
(function () {
  'use strict';
  var cfgAll = window.BREAKPATCH_PADDLE || {};
  var env = cfgAll.env === 'live' ? 'live' : 'sandbox';
  var cfg = cfgAll[env] || { prices: {} };
  var $ = function (id) { return document.getElementById(id); };
  var usd = function (n) { return '$' + n.toLocaleString('en-US'); };
  var clamp = function (v, lo, hi) { v = Math.round(Number(v)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };

  // ---------- Paddle.js, shared by both cards ----------

  // GET a JSON answer from the back office, or null (assets/get-json.js, loaded before this file).
  var getJson = typeof window.breakpatchGetJson === 'function' ? window.breakpatchGetJson : function () { return Promise.resolve(null); };

  var loading = null;
  // The card that opened the checkout says what went wrong. Until one has (a Paddle payment link,
  // ?_ptxn=…), the message shows on the Team card.
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
  team();

  // A Paddle payment link (an invoice or a payment method update Paddle sends people here with):
  // Paddle.js opens that transaction's checkout itself once it's initialized.
  if (/[?&]_ptxn=txn_/.test(location.search) && cfg.clientToken) paddle().catch(function () {});

  // ---------- Solo: one person, one per company ----------

  function solo() {
    var SOLO = { month: 19, year: 16 };            // per month
    var form = $('solo-form');
    // Before Solo is on sale (paddle-config.js soloOnSale), its card is hidden (site.css .solo-only)
    // and nothing here runs: no domain check, no checkout.
    if (!form || cfgAll.soloOnSale !== true) return;
    var email = $('solo-email'), buy = $('solo-buy'), note = $('solo-buy-note'), err = $('solo-buy-error'), taken = $('solo-taken');
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
     * Whether the email's company already has Solo: GET soloDomainUrl?domain=… (only the domain is
     * sent, never the address) → { taken }. Null when it can't say; then checkout goes ahead and the
     * back office checks again.
     */
    // Asked once per domain: when the email field loses focus (so Buy doesn't wait for it), and
    // again on Buy only if the email changed.
    var asked = {};
    function domainTaken(domain) {
      var url = typeof cfgAll.soloDomainUrl === 'string' ? cfgAll.soloDomainUrl : '';
      if (!url || !/^[^\s@]+\.[^\s@]+$/.test(domain)) return Promise.resolve(null);
      if (!asked[domain]) {
        asked[domain] = getJson(url + '?domain=' + encodeURIComponent(domain)).then(function (b) { return b && typeof b.taken === 'boolean' ? b.taken : null; });
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
    email.addEventListener('input', function () { taken.hidden = true; });
    email.addEventListener('blur', function () { if (ready()) domainTaken(domainOf(email.value)); });

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      showError('');
      taken.hidden = true;
      if (!ready()) { location.href = betaMail(); return; }
      if (!form.reportValidity()) return;
      var who = email.value.trim().toLowerCase();
      var domain = domainOf(who);
      var id = priceId();
      buy.setAttribute('aria-busy', 'true');
      domainTaken(domain).then(function (isTaken) {
        if (isTaken) {
          // One Solo per company: someone there has it, so Team is the plan for them.
          $('solo-taken-domain').textContent = domain;
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

  // ---------- Team ----------

  function team() {
    var PRICE = { month: 20, year: 16 };           // per person per month
    var FOUNDING_PRICE = 12;                       // Team yearly with the founding discount (25% off), per person per month
    var MACHINE = { month: 40, year: 32 };         // per machine per month ($384 a year)
    var MIN_SEATS = 3;
    var MAX_SEATS = 1000;
    var FOUNDING_MAX_SEATS = 20;                   // the founding price is for teams of up to 20 people

    var form = $('team-form');
    if (!form) return;
    var seats = $('seats'), extra = $('machines'), email = $('email'), company = $('company');
    var buy = $('buy'), note = $('buy-note'), err = $('buy-error');
    var state = { period: 'year' };

    // The founding price: only when paddle-config.js has the discount id, and places are left. The
    // back office counts them (GET /api/founding → { total, taken }); if it can't be reached the offer
    // shows without a number (Paddle's usage limit is the real cap). All taken: nothing shows.
    var foundingId = typeof cfg.foundingDiscountId === 'string' ? cfg.foundingDiscountId.trim() : '';
    var founding = null;  // { discountId } once the offer is shown
    var foundingOn = $('founding-on');
    foundingOn.addEventListener('change', function () { render(); });
    function showFounding(left, total) {
      $('founding-title').textContent = 'Founding teams: $12/person/month for 24 months · ' + (left == null ? '25 places' : left + ' of ' + total + ' places left');
      $('founding').hidden = false;
      founding = { discountId: foundingId };
      render();
    }
    if (/^dsc_[a-z0-9]+$/.test(foundingId)) placesLeft().then(function (p) {
      if (!p) showFounding(null);
      else if (p.taken < p.total) showFounding(p.total - p.taken, p.total);
    });
    /** { total, taken } from the back office, or null when it can't say (then the offer shows without a number). */
    function placesLeft() {
      return getJson(typeof cfgAll.foundingPlacesUrl === 'string' ? cfgAll.foundingPlacesUrl : '').then(function (b) {
        var ok = b && Number.isInteger(b.total) && Number.isInteger(b.taken) && b.total > 0 && b.taken >= 0;
        return ok ? { total: b.total, taken: b.taken } : null;
      });
    }
    /** Whether the founding option is offered: offer shown, Team yearly, and 20 people or fewer. */
    function foundingOffered() { return !!founding && state.period === 'year' && clamp(seats.value, MIN_SEATS, MAX_SEATS) <= FOUNDING_MAX_SEATS; }
    /** Whether this checkout gets the founding discount: offered and the box ticked. Extra machines never do. */
    function foundingApplies() { return foundingOffered() && foundingOn.checked; }

    function priceIds() {
      var p = cfg.prices || {};
      return state.period === 'year' ? { seat: p.teamYearly, machine: p.machineYearly } : { seat: p.teamMonthly, machine: p.machineMonthly };
    }
    function ready() {
      var ids = priceIds();
      return !!(cfg.clientToken && ids.seat && (Number(extra.value) === 0 || ids.machine));
    }

    function render() {
      var n = clamp(seats.value, MIN_SEATS, MAX_SEATS);
      var m = clamp(extra.value, 0, 100);
      var yearly = state.period === 'year';
      document.querySelectorAll('[data-period]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.period === state.period)); });
      var f = foundingApplies();
      var seatPrice = f ? FOUNDING_PRICE : PRICE[state.period];
      $('founding-opt').hidden = !foundingOffered();
      $('founding-cap').hidden = !(founding && yearly && n > FOUNDING_MAX_SEATS);
      $('team-price').textContent = usd(seatPrice);
      $('team-per').textContent = yearly ? 'per person per month, billed yearly' + (f ? ', for 24 months' : '') : 'per person per month';
      $('team-alt').textContent = f ? 'Founding price, then the Team yearly price at that time, with 60 days’ notice. $20 month to month.'
        : yearly ? '$20 month to month. Save $48 per person per year.'
        : founding ? 'Or $16 per person per month, billed yearly, or $12 at the founding price.' : 'Or $16 per person per month, billed yearly.';
      $('machine-price').textContent = yearly ? '$384 a year each' : '$40 a month each';
      var perMonth = n * seatPrice + m * MACHINE[state.period];
      $('total').textContent = yearly ? usd(perMonth * 12) + ' a year' : usd(perMonth) + ' a month';
      $('total-sub').textContent = n + (n === 1 ? ' person' : ' people') + ', ' + (1 + m) + ' machine licence' + (m ? 's' : '') + ' (1 included).' + (f ? ' Founding price for the first 24 months.' : '');
      var ok = ready();
      if (ok) $('total-sub').textContent += ' Tax is added at checkout.';
      // Work email and Company are for Paddle's checkout: while it's off, they're hidden.
      $('buyer').hidden = !ok;
      // Until checkout is set up, the button invites people to the free beta instead.
      buy.disabled = false;
      buy.textContent = ok ? 'Buy Team' : 'Join the free beta';
      note.hidden = ok;
    }

    document.querySelectorAll('[data-period]').forEach(function (b) {
      b.addEventListener('click', function () { state.period = b.dataset.period; render(); });
    });
    document.querySelectorAll('[data-step]').forEach(function (b) {
      b.addEventListener('click', function () {
        var input = $(b.dataset.for);
        var lo = input === seats ? MIN_SEATS : 0;
        input.value = clamp(Number(input.value) + Number(b.dataset.step), lo, input === seats ? MAX_SEATS : 100);
        render();
      });
    });
    [seats, extra].forEach(function (i) {
      i.addEventListener('input', render);
      i.addEventListener('change', function () { i.value = clamp(i.value, i === seats ? MIN_SEATS : 0, i === seats ? MAX_SEATS : 100); render(); });
    });

    /** The beta email, with what the visitor picked, so the draft isn't empty. */
    function betaMail() {
      var n = clamp(seats.value, MIN_SEATS, MAX_SEATS), m = clamp(extra.value, 0, 100);
      var body = 'Hello,\n\nWe would like to join the Breakpatch Team beta.\n\n'
        + 'People: ' + n + '\n'
        + 'Extra machine licences: ' + m + '\n'
        + 'Billing: ' + (state.period === 'year' ? 'yearly' : 'monthly') + '\n'
        + 'Company: \n';
      return 'mailto:support@breakpatch.dev?subject=' + encodeURIComponent('Breakpatch Team beta') + '&body=' + encodeURIComponent(body);
    }
    function showError(text) { err.textContent = text; err.hidden = !text; }

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      showError('');
      if (!ready()) { location.href = betaMail(); return; }
      if (!form.reportValidity()) return;
      var n = clamp(seats.value, MIN_SEATS, MAX_SEATS);
      var m = clamp(extra.value, 0, 100);
      var ids = priceIds();
      var discountId = foundingApplies() ? founding.discountId : null;
      var items = [{ priceId: ids.seat, quantity: n }];
      if (m > 0) items.push({ priceId: ids.machine, quantity: m });
      var who = email.value.trim().toLowerCase();
      var org = company.value.trim().slice(0, 120);
      buy.setAttribute('aria-busy', 'true');
      paddle().then(function (P) {
        onCheckoutError = function () {
          showError('The checkout couldn’t continue. ' + (foundingApplies() ? 'If the founding places are gone, untick Founding price and try again, or email support@breakpatch.dev.' : 'Try again, or email support@breakpatch.dev.'));
        };
        var opts = {
          items: items,
          customer: { email: who },
          // Kept on the transaction and the subscription; the licence takes its name from `company`.
          customData: { company: org, email: who },
          settings: settings(),
        };
        // Paddle applies it to the Team yearly price only, and ends it after 2 yearly periods.
        if (discountId) opts.discountId = discountId;
        P.Checkout.open(opts);
      }).catch(function () {
        showError('The checkout couldn’t be loaded. Check your connection, or email support@breakpatch.dev.');
      }).finally(function () { buy.removeAttribute('aria-busy'); });
    });

    render();
  }
})();

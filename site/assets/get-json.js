// The one way breakpatch.dev asks the back office for something (the founding places and the Solo
// domain check on /pricing, the test run count on the home page): a plain GET, never with cookies.
(function () {
  'use strict';
  /**
   * GET a JSON answer: the body, or null when it can't be had (offline, a non-2xx answer, or
   * `timeoutMs`, 5 s by default, without one).
   */
  window.breakpatchGetJson = function (url, timeoutMs) {
    if (!url || typeof window.fetch !== 'function') return Promise.resolve(null);
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, timeoutMs || 5000) : null;
    return window.fetch(url, { credentials: 'omit', signal: ctl ? ctl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .finally(function () { if (timer) clearTimeout(timer); });
  };
})();

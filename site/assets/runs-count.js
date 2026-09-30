// The home page's "12,300 tests run with Breakpatch" line. The back office keeps a running total of
// the test runs every edition reports (breakpatch-team: backoffice/functions/src/testRuns.ts) and
// answers GET /api/test-runs → { runs }, already rounded down to a round figure. The line stays
// hidden below 100 runs, and whenever the answer doesn't come (offline, an error, 5 s without one).
// It sits outside the page's flow and fades in, so nothing moves when it appears.
(function () {
  'use strict';
  // Until account.breakpatch.dev is connected: 'https://breakpatch-backoffice.web.app/api/test-runs'.
  var URL_ = 'https://account.breakpatch.dev/api/test-runs';
  var MIN_RUNS = 100;
  var el = document.getElementById('runs-count');
  if (!el || typeof window.breakpatchGetJson !== 'function') return;
  window.breakpatchGetJson(URL_).then(function (b) {
    var n = b && b.runs;
    if (!Number.isSafeInteger(n) || n < MIN_RUNS) return;
    document.getElementById('runs-count-n').textContent = n.toLocaleString('en-GB');
    el.hidden = false;
  });
})();

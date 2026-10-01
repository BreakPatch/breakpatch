// The run report bridge (report/index.html): a result message or an issue links to
//   https://breakpatch.dev/report#r=<appId>/<runId>
// and this page opens breakpatch://report/<appId>/<runId> on the Mac. The part after # never
// reaches a server. Ids are the app's own (letters, digits, - and _), so nothing else is passed on.
(function (root) {
  const ID = /^[A-Za-z0-9_-]{1,128}$/;
  /** The breakpatch:// link for a page address's #r=…, or null when it isn't one. */
  function reportDeepLink(hash) {
    const r = new URLSearchParams(String(hash || '').replace(/^#/, '')).get('r');
    if (!r) return null;
    const parts = r.split('/');
    if (parts.length !== 2 || !parts.every(p => ID.test(p))) return null;
    return 'breakpatch://report/' + parts[0] + '/' + parts[1];
  }
  root.bpReportDeepLink = reportDeepLink;
})(typeof window !== 'undefined' ? window : globalThis);

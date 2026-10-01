// JUnit XML from the report's view: one <testcase> per test, as GitHub, GitLab and Jenkins read
// it. breakpatch-ci writes the same bytes (the open engine's breakpatch_engine/report/junit.py):
// both are checked against engine/tests/fixtures/report/report-*.junit.xml.
import type { ReportView } from './view';

// eslint-disable-next-line no-control-regex
const BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** Text or an attribute value, with what XML 1.0 can't hold left out. */
export const xmlEscape = (v: unknown) => String(v).replace(BAD, '').replace(/[&<>"']/g, c => ESC[c]);

export function junitXml(view: ReportView): string {
  const j = view.junit;
  const name = xmlEscape(j.name);
  const stamp = j.timestamp ? ` timestamp="${xmlEscape(j.timestamp)}"` : '';
  const counts = `tests="${j.tests}" failures="${j.failures}" errors="0" skipped="${j.skipped}" time="${xmlEscape(j.seconds)}"`;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites name="${name}" ${counts}>`, `  <testsuite name="${name}" ${counts}${stamp}>`];
  for (const t of view.tests) {
    const c = t.junit;
    const head = `    <testcase name="${xmlEscape(t.name)}" classname="${xmlEscape(t.appName || j.name)}" time="${xmlEscape(c.seconds)}"`;
    if (c.status === 'passed') { out.push(`${head}/>`); continue; }
    out.push(`${head}>`);
    out.push(c.status === 'skipped'
      ? `      <skipped message="${xmlEscape(c.message)}"/>`
      : `      <failure message="${xmlEscape(c.message)}" type="${xmlEscape(c.type)}">${xmlEscape(c.text)}</failure>`);
    out.push('    </testcase>');
  }
  out.push('  </testsuite>', '</testsuites>', '');
  return out.join('\n');
}

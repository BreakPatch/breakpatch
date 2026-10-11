// JUnit XML from the report's view: one <testcase> per test, as GitHub, GitLab and Jenkins read
// it, with each earlier try of a retried test. breakpatch-ci writes the same bytes (the open engine's breakpatch_engine/report/junit.py):
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
    const retries = c.retries ?? [];
    if (c.status === 'passed' && !retries.length) { out.push(`${head}/>`); continue; }
    out.push(`${head}>`);
    // Earlier tries (engine "Retries"), as Maven Surefire writes reruns: <flakyFailure> for each in a
    // test that passed in the end (Jenkins and others show it as flaky). In one that failed every
    // try, <failure> is the first try's and <rerunFailure> each later one's, this last try's included.
    const tag = c.status === 'passed' ? 'flakyFailure' : 'rerunFailure';
    let later = retries;
    if (c.status === 'skipped') out.push(`      <skipped message="${xmlEscape(c.message)}"/>`);
    else if (c.status !== 'passed') {
      const [first, ...rest] = [...retries, c];
      later = rest;
      out.push(`      <failure message="${xmlEscape(first.message)}" type="${xmlEscape(first.type)}">${xmlEscape(first.text)}</failure>`);
    }
    for (const r of later) out.push(`      <${tag} message="${xmlEscape(r.message)}" type="${xmlEscape(r.type)}">${xmlEscape(r.text)}</${tag}>`);
    out.push('    </testcase>');
  }
  out.push('  </testsuite>', '</testsuites>', '');
  return out.join('\n');
}

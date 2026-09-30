// An exported run report (issue #43): one self-contained HTML file (which also prints to PDF), and
// JUnit XML. The template is the open engine's (engine/src/breakpatch_engine/report/template.html):
// breakpatch-ci fills the same file in Python, and both are checked against the same golden files
// (engine/tests/fixtures/report/, report.test.ts here and the engine's test_report.py).
import template from '../../../../engine/src/breakpatch_engine/report/template.html?raw';
import { render } from './render';
import type { ReportView } from './view';

export { buildView, allOpen } from './view';
export type { ReportInput, ReportTestInput, ReportView, ReportImage, ReportRun, ReportStepRun } from './view';
export { junitXml } from './junit';

export const REPORT_TEMPLATE: string = template;

export function reportHtml(view: ReportView): string { return render(REPORT_TEMPLATE, view); }

/** The page's styles and its body (between the bpr-body comments), to print inside the app's window. */
export function printableParts(html: string): { css: string; body: string } {
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  const start = html.indexOf('<!--bpr-body-->'), end = html.indexOf('<!--/bpr-body-->');
  return { css, body: start >= 0 && end > start ? html.slice(start + 15, end) : '' };
}

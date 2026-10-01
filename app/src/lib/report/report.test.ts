// Golden files for the exported report (issue #43). The same files check breakpatch-ci's Python
// (engine/tests/test_report.py), so the app and CI make the same report from the same template.
// Write them again after a deliberate change: BP_WRITE_GOLDEN=1 npx vitest run src/lib/report/report.test.ts
import { describe, expect, it } from 'vitest';
import { allOpen, buildView, junitXml, printableParts, REPORT_TEMPLATE, reportHtml, type ReportInput } from '.';
import { parse, render, TemplateError } from './render';
import { countsText, isoText, reportRows, seconds, shortTime, whenText } from './view';
import { xmlEscape } from './junit';

const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(p: string, e: 'utf8'): string; writeFileSync(p: string, d: string): void };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const dir = join(dirname(fileURLToPath(import.meta.url)), '../../../../engine/tests/fixtures/report');
const INPUT = JSON.parse(fs.readFileSync(join(dir, 'input.json'), 'utf8')) as Record<string, ReportInput>;
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};

function golden(name: string, text: string) {
  const path = join(dir, name);
  if (env.BP_WRITE_GOLDEN === '1') fs.writeFileSync(path, text);
  expect(text).toBe(fs.readFileSync(path, 'utf8'));
}

describe('the same files as breakpatch-ci', () => {
  for (const c of Object.keys(INPUT).sort()) {
    it(`view: ${c}`, () => expect(buildView(INPUT[c])).toEqual(JSON.parse(fs.readFileSync(join(dir, `view-${c}.json`), 'utf8'))));
    it(`HTML: ${c}`, () => golden(`report-${c}.html`, reportHtml(buildView(INPUT[c]))));
    it(`JUnit XML: ${c}`, () => golden(`report-${c}.junit.xml`, junitXml(buildView(INPUT[c]))));
  }
});

describe('the report', () => {
  it('shows a failed step with its reason, the AI assistant and its screenshot, open', () => {
    const steps = buildView(INPUT.run).tests[0].steps;
    const done = steps.find(s => s.label === 'Click Done')!;
    expect(done).toMatchObject({ number: '7', open: true, result: 'failed', headline: "Couldn't find the Done button", image: { size: 'full' } });
    expect(done.explanation).toEqual({ summary: 'The Done button moved into a menu after the redesign.', cause: 'It moved', suggestion: 'Re-record this step.' });
    expect(steps.find(s => s.number === '2.2')!.image?.size).toBe('small');
    expect(steps.map(s => s.number)).toEqual(['1', '2', '2.1', '2.2', '3', '4', '5', '6', '7', '8']);
  });

  it('leaves the screenshots out when asked', () => {
    const view = buildView({ ...INPUT.run, screenshots: false });
    expect(view.tests[0].steps.every(s => s.image === null)).toBe(true);
    const html = reportHtml(view);
    expect(html).not.toContain('data:image/');
    expect(html).toContain('Screenshots were left out');
  });

  it('makes no external requests', () => {
    const html = reportHtml(buildView(INPUT.run));
    expect(html).toContain("default-src 'none'; img-src data:");
    expect(html).not.toMatch(/(src|href|action)\s*=\s*["']?(https?:|\/\/)/i);
    expect(html).not.toContain('url(');
  });

  it('escapes what it shows', () => {
    const html = reportHtml(buildView(INPUT.run));
    expect(html).toContain('Write &lt;Q4&gt; &amp; friends');
    expect(html).not.toContain('<Q4>');
  });

  it('opens every step for printing, and hands the app its printable parts', () => {
    const view = allOpen(buildView(INPUT.run));
    expect(view.tests[0].steps.every(s => s.open === s.hasDetail)).toBe(true);
    const { css, body } = printableParts(reportHtml(view));
    expect(css).toContain('@media print');
    expect(body).toContain('<div class="bpr" id="bpr">');
    expect(body).not.toContain('<script');
  });

  it('stays small without screenshots: 30 steps', () => {
    const steps = Array.from({ length: 30 }, (_, i) => ({ id: `s${i}`, action: 'click' as const, label: `Click button ${i}`, target: `Button ${i}` }));
    const run = { ...INPUT.run.tests[0].run!, steps: steps.map(s => ({ stepId: s.id, result: 'passed' as const, timings: { preMs: 100, actionMs: 80, settleMs: 300, postMs: 40 } })) };
    const html = reportHtml(buildView({ ...INPUT.run, tests: [{ appName: 'App', name: 'Big', steps, run }] }));
    expect(new TextEncoder().encode(html).length).toBeLessThan(120_000);
  });
});

describe('JUnit XML', () => {
  it('is well formed and counts right', () => {
    const doc = new DOMParser().parseFromString(junitXml(buildView(INPUT.suite)), 'application/xml');
    expect(doc.querySelector('parsererror')).toBeNull();
    expect(doc.documentElement.getAttribute('failures')).toBe('2');
    expect([...doc.querySelectorAll('testcase')].map(c => c.getAttribute('name'))).toEqual(['Sign in', 'Invite a teammate', 'Pay an invoice', 'Refund']);
  });

  it('says a stopped run was skipped', () => {
    const stopped = structuredClone(INPUT.run);
    stopped.tests[0].run!.steps.at(-1)!.reason = 'stopped';
    const xml = junitXml(buildView(stopped));
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<skipped message="You stopped the run"/>');
  });

  it('leaves out what XML 1.0 cannot hold', () => { expect(xmlEscape('a\u0000b\u001fc<')).toBe('abc&lt;'); });
});

describe('the template language', () => {
  it('fills sections, inverted sections and dotted names', () => {
    const t = '{{#items}}[{{name}}{{#flag}}!{{/flag}}{{^flag}}?{{/flag}}{{top}}]{{/items}}{{^items}}none{{/items}}{{a.b}}{{! gone }}';
    expect(render(t, { items: [{ name: 'x', flag: true }, { name: '<y>', flag: false }], top: 'T', a: { b: 1 } })).toBe('[x!T][&lt;y&gt;?T]1');
    expect(render(t, { items: [], a: {} })).toBe('none');
    expect(render('{{#o}}{{v}}{{/o}}', { o: { v: '' }, v: 'outer' })).toBe('');
    expect(render('{{v}}', { v: 'a&b\'"' })).toBe('a&amp;b&#39;&quot;');
    for (const bad of ['{{#a}}', '{{/a}}', '{{&a}}', '{{>a}}', '{{#a}}{{/b}}']) expect(() => parse(bad), bad).toThrow(TemplateError);
  });

  it('parses the shared template', () => {
    expect(() => parse(REPORT_TEMPLATE)).not.toThrow();
    expect(REPORT_TEMPLATE.split('<!--bpr-body-->')).toHaveLength(2);
  });
});

describe('words and numbers', () => {
  it('as view.py writes them', () => {
    expect([shortTime(38), shortTime(999), shortTime(1050), shortTime(12_349)]).toEqual(['38 ms', '999 ms', '1.1 s', '12.3 s']);
    expect(seconds(68_250)).toBe('68.250');
    expect(whenText(1790258400000, 0)).toBe('24 Sep 2026, 14:00 UTC');
    expect(whenText(1790258400000, 330)).toBe('24 Sep 2026, 19:30 UTC+5:30');
    expect(whenText(1790258400000, -180)).toBe('24 Sep 2026, 11:00 UTC-3');
    expect(isoText(1790258400000)).toBe('2026-09-24T14:00:00');
    expect(countsText({ total: 6, passed: 5, fixed: 1 })).toBe('6 of 6 tests passed, 1 fixed automatically');
    expect(countsText({ total: 6, passed: 3, failed: 2, notRun: 1 })).toBe('3 of 6 tests passed, 2 failed, 1 not run');
    expect(reportRows([{ id: 'l', action: 'loop', label: 'L', steps: [{ id: 'c', action: 'click', label: 'C' }] }]).map(r => [r.number, r.depth])).toEqual([['1', 0], ['2', 1]]);
  });
});

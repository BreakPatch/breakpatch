// What an export needs, from what the app has: the report input for one run or a suite's runs,
// with the screenshots (engine `report.images`, WebP: full size for a failed step, small for the
// rest), then the files themselves. The report screen and the suite run screen use it, and in
// Team the local runner (runner/htmlReport.ts) for every suite run.
import type { Run, Step, Viewport } from '../../data/types';
import type { Engine } from '../../engine/engine';
import { appVersion, saveTextFile } from '../../platform';
import { junitXml } from './junit';
import { allOpen, buildView, type ReportInput, type ReportStepRun, type ReportView } from './view';
import { reportHtml } from '.';

export interface ExportTest {
  appName: string;
  name: string;
  /** The steps as the run tested them (shared steps filled in). */
  steps: Step[];
  run: Run | null;
  viewport?: Pick<Viewport, 'width'>;
  note?: string;
}

export type ExportFormat = 'html' | 'pdf' | 'junit';

/** The containers (loops, shared-steps cards) among `steps`: their screenshot is their child's. */
function containerIds(steps: Step[], out = new Set<string>()): Set<string> {
  for (const s of steps) if (s.steps?.length) { if (s.action === 'loop' || s.action === 'group') out.add(s.id); containerIds(s.steps, out); }
  return out;
}

/** The run's steps with each screenshot as `image`, when the engine can give it. A screenshot it can't read is left out. */
export async function withImages(t: ExportTest, engine: Pick<Engine, 'reportImages'> | null | undefined): Promise<ReportStepRun[]> {
  const steps: ReportStepRun[] = t.run?.steps ?? [];
  if (!engine?.reportImages || !t.run) return steps;
  const skip = containerIds(t.steps);
  const want = steps.map((r, i) => ({ r, i })).filter(({ r }) => r.screenshotPath && !skip.has(r.stepId));
  if (!want.length) return steps;
  const got = await engine.reportImages(want.map(({ r }) => ({ path: r.screenshotPath!, size: r.result === 'failed' ? 'full' : 'small' })), t.viewport?.width)
    .catch(() => [] as null[]);
  const out = [...steps];
  want.forEach(({ r, i }, k) => { const g = got[k]; if (g?.src) out[i] = { ...r, image: { src: g.src, width: g.width, height: g.height } }; });
  return out;
}

export async function reportInput(o: {
  kind: 'run' | 'suite'; name: string; tests: ExportTest[]; screenshots: boolean;
  suite?: ReportInput['suite']; engine?: Pick<Engine, 'reportImages'> | null; now?: number;
}): Promise<ReportInput> {
  const now = o.now ?? Date.now();
  const tests = await Promise.all(o.tests.map(async t => ({
    appName: t.appName, name: t.name, steps: t.steps, ...(t.note ? { note: t.note } : {}),
    run: t.run ? { ...t.run, steps: o.screenshots ? await withImages(t, o.engine) : t.run.steps } : null,
  })));
  return {
    kind: o.kind, name: o.name, appVersion: appVersion(), generatedAt: now, tzOffsetMinutes: -new Date(now).getTimezoneOffset(),
    screenshots: o.screenshots, ...(o.suite ? { suite: o.suite } : {}), tests,
  };
}

/** "create-a-project-2026-09-24": a file name from the report's heading and the day. */
export function fileStem(heading: string, at: number): string {
  const d = new Date(at);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const slug = heading.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug || 'breakpatch-report'}-${day}`;
}

/** The file for a format: its name, text and media type. PDF is printed instead (print.ts). */
export function exportFile(view: ReportView, format: 'html' | 'junit', at = Date.now()): { name: string; text: string; type: string } {
  const stem = fileStem(view.heading, at);
  return format === 'junit'
    ? { name: `${stem}.junit.xml`, text: junitXml(view), type: 'application/xml' }
    : { name: `${stem}.html`, text: reportHtml(view), type: 'text/html' };
}

/**
 * Exports: HTML and JUnit XML to a file the person picks, PDF through the print dialog (Save as
 * PDF). false when the save dialog was cancelled.
 */
export async function exportReport(input: ReportInput, format: ExportFormat): Promise<boolean> {
  const view = buildView(input);
  if (format === 'pdf') {
    const { printReport } = await import('./print');
    await printReport(reportHtml(allOpen(view)));
    return true;
  }
  const f = exportFile(view, format);
  return saveTextFile(f.name, f.text, {
    type: f.type,
    filters: [format === 'junit' ? { name: 'JUnit XML', extensions: ['xml'] } : { name: 'Web page', extensions: ['html'] }],
  });
}

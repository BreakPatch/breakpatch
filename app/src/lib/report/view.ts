// The exported report's view: everything the template shows, in plain words, from a run (or a
// suite's runs) as the app stores them. breakpatch-ci builds the same view in Python (the open
// engine's breakpatch_engine/report/view.py); both are checked against
// engine/tests/fixtures/report/view-*.json, built from input.json. The words are the report's own
// (lib/runWords.ts, lib/explain.ts), so view.py repeats them: change them together.
import type { Explanation, Run, Step, StepRun } from '../../data/types';
import { UNCHECKED_NOTE, WHERE, passNote, reasonAdvice, reasonText, reasonTitle, runBy, targetName, tookText } from '../runWords';
import { CAUSE_TEXT, SUGGESTION_TEXT } from '../explain';

/** A screenshot, as a WebP data: URI (the engine's `report.images`). */
export interface ReportImage { src: string; width: number; height: number }
export type ReportStepRun = StepRun & { image?: ReportImage };
export type ReportRun = Omit<Run, 'steps' | 'appId' | 'testId'> & Partial<Pick<Run, 'appId' | 'testId'>> & { steps: ReportStepRun[] };

export interface ReportTestInput {
  appName: string;
  name: string;
  /** The steps as the run tested them (shared steps filled in). */
  steps: Step[];
  run: ReportRun | null;
  /** Why there's no run: "Couldn't run: it was deleted". */
  note?: string;
}

export interface ReportInput {
  kind: 'run' | 'suite';
  name: string;
  appVersion: string;
  generatedAt: number;
  /** Minutes east of UTC, for the times shown ("UTC+1"). */
  tzOffsetMinutes: number;
  /** false: the screenshots were left out. */
  screenshots: boolean;
  suite?: { result: string; counts: { total: number; passed: number; fixed: number; failed: number; notRun: number }; requestedBy: string; startedAt: number; finishedAt: number; note?: string };
  tests: ReportTestInput[];
}

export type StepState = 'passed' | 'fixed' | 'failed' | 'stopped' | 'notRun';
export interface Meta { k: string; v: string }
export interface StepView {
  number: string; depth: number; label: string; result: StepState; resultText: string;
  headline: string; body: string; stepNote: string; system: string;
  explanation: { summary: string; cause: string; suggestion: string } | null;
  advice: string; took: string; phases: string;
  image: (ReportImage & { size: 'full' | 'small'; alt: string; caption: string }) | null;
  open: boolean; hasDetail: boolean;
}
export interface JunitCase { seconds: string; timestamp: string; status: 'passed' | 'failed' | 'skipped'; type: string; message: string; text: string }
export interface TestView {
  anchor: string; name: string; appName: string; multi: boolean; result: StepState; resultText: string;
  meta: Meta[]; testNote: string; stepsText: string; steps: StepView[]; junit: JunitCase;
}
export interface ReportView {
  title: string; generator: string; kindLabel: string; heading: string; result: StepState; resultText: string;
  countsText: string; summary: Meta[]; note: string; screenshotsLeftOut: boolean; multi: boolean;
  tests: TestView[]; footer: string;
  junit: { name: string; tests: number; failures: number; skipped: number; seconds: string; timestamp: string };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RESULT_TEXT: Record<StepState, string> = { passed: 'Passed', fixed: 'Fixed automatically', failed: 'Failed', stopped: 'Stopped', notRun: 'Not run' };
const RUN_TEXT: Record<StepState, string> = { passed: 'Passed', fixed: 'Passed with fixes', failed: 'Failed', notRun: 'Not run', stopped: 'Stopped' };
const SUITE_RESULT: Record<string, StepState> = { passed: 'passed', passed_with_fixes: 'fixed', failed: 'failed', replaced: 'notRun' };
const SUITE_TEXT: Record<string, string> = { passed: 'Passed', passed_with_fixes: 'Passed with fixes', failed: 'Failed', replaced: 'Replaced by a newer request' };
const NO_SCREENS = ['secretMissing', 'setUpFailed', 'stopped', 'healingUnavailable'];
const SCREEN_CHECKS = ['targetNotFound', 'unexpectedScreen', 'healFailed', 'timeout'];

// ---------- numbers and times ----------

const int = (v: unknown) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "38 ms" under a second, else "1.2 s" (rounded half up from whole milliseconds). */
export function shortTime(ms: unknown): string {
  const n = int(ms);
  if (n < 1000) return `${n} ms`;
  const t = Math.floor((n + 50) / 100);
  return `${Math.floor(t / 10)}.${t % 10} s`;
}

/** "68.250": JUnit's seconds, from whole milliseconds. */
export function seconds(ms: unknown): string { const n = int(ms); return `${Math.floor(n / 1000)}.${pad(n % 1000, 3)}`; }

/** "24 Sep 2026, 14:10 UTC", or "UTC+1", "UTC+5:30", "UTC-3" away from UTC. */
export function whenText(ms: unknown, offsetMin = 0): string {
  const d = new Date(int(ms) + offsetMin * 60_000);
  const h = Math.floor(Math.abs(offsetMin) / 60), m = Math.abs(offsetMin) % 60;
  const zone = offsetMin ? `UTC${offsetMin > 0 ? '+' : '-'}${h}${m ? `:${pad(m)}` : ''}` : 'UTC';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} ${zone}`;
}

/** "2026-09-24T14:10:00": JUnit's timestamp, in UTC. */
export function isoText(ms: unknown): string { return new Date(int(ms)).toISOString().slice(0, 19); }

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ---------- steps ----------

/**
 * Every step in the order the report lists them, with its number and depth: loop children are
 * rows of their own (as the steps list numbers them), a shared-steps card's steps are "2.1", "2.2".
 */
export function reportRows(steps: Step[]): { step: Step; number: string; depth: number }[] {
  const out: { step: Step; number: string; depth: number }[] = [];
  let count = 0;
  const inner = (list: Step[], prefix: string, depth: number) => list.forEach((c, i) => {
    const n = `${prefix}.${i + 1}`;
    out.push({ step: c, number: n, depth });
    if ((c.action === 'loop' || c.action === 'group') && c.steps?.length) inner(c.steps, n, depth + 1);
  });
  const walk = (list: Step[], depth: number) => {
    for (const s of list) {
      count++;
      out.push({ step: s, number: String(count), depth });
      if (s.action === 'loop' && s.steps?.length) walk(s.steps, depth + 1);
      else if (s.action === 'group' && s.steps?.length) inner(s.steps, String(count), depth + 1);
    }
  };
  walk(steps, 0);
  return out;
}

export function stepState(r: StepRun | undefined): StepState {
  if (!r) return 'notRun';
  if (r.result === 'failed') return r.reason === 'stopped' ? 'stopped' : 'failed';
  return r.result === 'healed' ? 'fixed' : r.result === 'passed' ? 'passed' : 'notRun';
}

function descendantFailed(step: Step, byId: Map<string, StepRun>): boolean {
  return (step.steps ?? []).some(c => byId.get(String(c.id))?.result === 'failed' || descendantFailed(c, byId));
}

function explanationView(e: Explanation | undefined): StepView['explanation'] {
  if (!e || typeof e.summary !== 'string' || !e.summary.trim()) return null;
  return { summary: e.summary.trim(), cause: (CAUSE_TEXT as Record<string, string>)[e.cause] ?? '', suggestion: (SUGGESTION_TEXT as Record<string, string>)[e.suggestion] ?? '' };
}

/** [the step's time, where it went] from its `timings`. */
export function phases(t: StepRun['timings']): [string, string] {
  if (!t) return ['', ''];
  const parts: [number | undefined, string][] = [
    [t.preMs, 'check before'], [t.actionMs, 'doing the step'],
    [t.settleMs, t.settled !== false ? 'waiting for the page to settle' : 'waiting for the page, which never settled'], [t.postMs, 'check after'],
  ];
  const have = parts.filter(([ms]) => int(ms) > 0);
  if (!have.length) return ['', ''];
  const total = have.reduce((a, [ms]) => a + int(ms), 0);
  return [shortTime(total), have.map(([ms, what]) => `${what} ${shortTime(ms)}`).join(' · ')];
}

function systemText(run: Pick<ReportRun, 'systemMismatch'>, r: StepRun | undefined): string {
  const m = run.systemMismatch;
  if (!m?.message || !r || r.result !== 'failed' || !SCREEN_CHECKS.includes(r.reason ?? '')) return '';
  return String(m.message);
}

type StepViewX = StepView & { reasonCode: string };

function stepView(step: Step, number: string, depth: number, r: ReportStepRun | undefined, run: Partial<ReportRun>, byId: Map<string, StepRun>, screenshots: boolean): StepViewX {
  const state = stepState(r);
  const container = !!step.steps?.length && (step.action === 'loop' || step.action === 'group');
  const quiet = container && ['failed', 'stopped', 'fixed'].includes(state) && (descendantFailed(step, byId) || state === 'fixed');
  const reason = r?.reason;
  let headline = '', body = '', advice = '';
  if (!quiet) {
    if (state === 'failed') { headline = reasonTitle(reason, step); body = reasonText(reason, step); advice = reasonAdvice(reason); }
    else if (state === 'stopped') { headline = reasonTitle('stopped', step); body = reasonText('stopped', step); }
    else if (state === 'fixed') {
      const name = targetName(step);
      headline = `${name.charAt(0).toUpperCase()}${name.slice(1)} had moved. The AI assistant found it.`;
      body = 'It was used in the new position and the screen afterwards looked right.';
    }
  }
  const stepNote = r && state === 'passed' ? (r.unchecked?.length ? UNCHECKED_NOTE : passNote(r) ?? '') : '';
  const [took, where] = phases(r?.timings);
  const img = screenshots && !container ? r?.image : undefined;
  const image: StepView['image'] = img && typeof img.src === 'string' && img.src.startsWith('data:image/') && !(state === 'failed' && NO_SCREENS.includes(reason ?? ''))
    ? {
        src: img.src, width: int(img.width), height: int(img.height), size: state === 'failed' ? 'full' : 'small',
        alt: `Screenshot: step ${number}, ${step.label ?? ''}`.replace(/[, ]+$/, ''),
        caption: state === 'failed' ? 'What was on screen when the step failed' : state === 'fixed' ? 'Where the AI assistant found it' : 'The screen at this step',
      }
    : null;
  const explanation = state === 'failed' && !quiet ? explanationView(r?.explanation) : null;
  const system = quiet ? '' : systemText(run, r);
  return {
    number, depth, label: String(step.label ?? ''), result: state, resultText: RESULT_TEXT[state],
    headline, body, stepNote, system, explanation, advice, took, phases: where, image,
    open: state === 'failed' && !quiet,
    hasDetail: !!(headline || body || stepNote || system || explanation || advice || where || image),
    reasonCode: state === 'failed' && headline ? String(reason ?? '') : '',
  };
}

// ---------- a test's run ----------

function runState(run: ReportRun | null, steps: StepView[]): StepState {
  if (!run) return 'failed';
  if (run.result === 'fail') return steps.some(s => s.result === 'stopped') && !steps.some(s => s.result === 'failed') ? 'stopped' : 'failed';
  return int(run.healedCount) > 0 ? 'fixed' : 'passed';
}

function runMeta(run: ReportRun, offset: number): Meta[] {
  const meta: Meta[] = [
    { k: 'Took', v: tookText(int(run.durationMs)) }, { k: 'Run by', v: runBy(run) },
    { k: 'Where', v: WHERE[run.source]?.label ?? String(run.source ?? '') },
    { k: 'Machine', v: String(run.machine ?? '') }, { k: 'When', v: whenText(run.startedAt, offset) },
  ];
  if (run.testVersion !== undefined && run.testVersion !== null) meta.push({ k: 'Version', v: String(run.testVersion) });
  if (run.id) meta.push({ k: 'Run ID', v: String(run.id) });
  return meta.filter(m => m.v);
}

function junitCase(state: StepState, steps: StepViewX[], t: ReportTestInput, run: ReportRun | null): JunitCase {
  const base = { seconds: seconds(run?.durationMs), timestamp: run ? isoText(run.startedAt) : '' };
  if (state === 'passed' || state === 'fixed') return { ...base, status: 'passed', type: '', message: '', text: '' };
  if (state === 'stopped') return { ...base, status: 'skipped', type: 'stopped', message: 'You stopped the run', text: '' };
  const failed = steps.filter(s => s.result === 'failed' && s.headline);
  if (!failed.length) {
    const note = run ? 'The run failed.' : String(t.note || "It couldn't run.");
    return { ...base, status: 'failed', type: run ? 'failed' : 'notRun', message: note, text: note };
  }
  const s = failed[failed.length - 1];
  const lines = [`Step ${s.number}: ${s.label}`, s.headline, s.body];
  if (s.explanation) {
    lines.push(`AI assistant: ${s.explanation.summary}`);
    if (s.explanation.cause) lines.push(`Likely cause: ${s.explanation.cause}.`);
    if (s.explanation.suggestion) lines.push(`Suggested: ${s.explanation.suggestion}`);
  }
  if (s.system) lines.push(s.system);
  lines.push(`What to try: ${s.advice}`);
  return { ...base, status: 'failed', type: s.reasonCode || 'failed', message: `Step ${s.number}: ${s.label}: ${s.headline}`, text: lines.filter(Boolean).join('\n') };
}

function testView(t: ReportTestInput, index: number, offset: number, screenshots: boolean, multi: boolean): TestView {
  const run = t.run ?? null;
  const byId = new Map<string, StepRun>((run?.steps ?? []).map(r => [String(r.stepId), r]));
  const withCode = run ? reportRows(t.steps ?? []).map(({ step, number, depth }) => stepView(step, number, depth, byId.get(String(step.id)), run, byId, screenshots)) : [];
  const state = runState(run, withCode);
  const junit = junitCase(state, withCode, t, run);
  const steps: StepView[] = withCode.map(({ reasonCode: _code, ...s }) => s);
  return {
    anchor: `test-${index + 1}`, name: String(t.name || run?.testName || 'Test'), appName: String(t.appName ?? ''), multi,
    result: state, resultText: run ? RUN_TEXT[state] : "Couldn't run", meta: run ? runMeta(run, offset) : [],
    testNote: run ? '' : String(t.note || "It couldn't run."), stepsText: plural(steps.length, 'step'), steps, junit,
  };
}

// ---------- the whole report ----------

export function countsText(c: Partial<Record<'total' | 'passed' | 'fixed' | 'failed' | 'notRun', number>>): string {
  const [total, passed, fixed, failed, notRun] = (['total', 'passed', 'fixed', 'failed', 'notRun'] as const).map(k => int(c[k]));
  let out = `${passed + fixed} of ${plural(total, 'test')} passed`;
  if (!failed && !notRun) return out + (fixed ? `, ${fixed} fixed automatically` : '');
  if (failed) out += `, ${failed} failed`;
  if (notRun) out += `, ${notRun} not run`;
  return out;
}

export function buildView(inp: ReportInput): ReportView {
  const raw = Number(inp.tzOffsetMinutes) || 0;
  const offset = int(Math.abs(raw)) * (raw < 0 ? -1 : 1);
  const shots = inp.screenshots !== false;
  const suite = inp.kind === 'suite';
  const tests = (inp.tests ?? []).map((t, i) => testView(t, i, offset, shots, suite));
  const version = String(inp.appVersion ?? '');
  const footer = `Made with Breakpatch${version ? ` ${version}` : ''} on ${whenText(inp.generatedAt, offset)}.`;
  let result: StepState, resultText: string, summary: Meta[], heading: string, kindLabel: string, counts: string, note: string, totalMs: number, stamp: string;
  if (suite) {
    const s = inp.suite ?? { result: 'failed', counts: { total: 0, passed: 0, fixed: 0, failed: 0, notRun: 0 }, requestedBy: '', startedAt: 0, finishedAt: 0 };
    result = SUITE_RESULT[s.result] ?? 'failed';
    resultText = SUITE_TEXT[s.result] ?? 'Failed';
    summary = [
      { k: 'Tests', v: plural(tests.length, 'test') }, { k: 'Took', v: tookText(int(s.finishedAt) - int(s.startedAt)) },
      { k: 'Asked by', v: String(s.requestedBy ?? '') }, { k: 'When', v: whenText(s.startedAt, offset) },
    ];
    heading = String(inp.name || 'Suite'); kindLabel = 'Suite report'; counts = countsText(s.counts ?? {}); note = String(s.note ?? '');
    totalMs = int(s.finishedAt) - int(s.startedAt); stamp = isoText(s.startedAt);
  } else {
    const t = tests[0];
    result = t?.result ?? 'notRun'; resultText = t?.resultText ?? 'Not run';
    summary = [...(t?.appName ? [{ k: 'App', v: t.appName }] : []), ...(t?.meta ?? [])];
    heading = t?.name ?? String(inp.name || 'Test'); kindLabel = 'Run report'; counts = ''; note = '';
    const run = inp.tests?.[0]?.run;
    totalMs = int(run?.durationMs); stamp = run ? isoText(run.startedAt) : '';
  }
  return {
    title: `${heading} · ${resultText} · Breakpatch`, generator: `Breakpatch${version ? ` ${version}` : ''}`,
    kindLabel, heading, result, resultText, countsText: counts, summary: summary.filter(m => m.v), note,
    screenshotsLeftOut: !shots, multi: suite, tests, footer,
    junit: {
      name: heading, tests: tests.length, failures: tests.filter(t => t.junit.status === 'failed').length,
      skipped: tests.filter(t => t.junit.status === 'skipped').length, seconds: seconds(totalMs), timestamp: stamp,
    },
  };
}

/** The same view with every step open: for printing, where a closed step would print closed. */
export function allOpen(view: ReportView): ReportView {
  return { ...view, tests: view.tests.map(t => ({ ...t, steps: t.steps.map(s => ({ ...s, open: s.hasDetail })) })) };
}

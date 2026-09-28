import { describe, expect, it } from 'vitest';
import type { Step } from '../../data/types';
import type { RunStepEvent } from '../../engine';
import { focusStep, INITIAL_RUN, overall, progress, rowStatus, runReducer, tally, type RunView } from './runState';

const st = (id: string, extra: Partial<Step> = {}): Step => ({ id, action: 'click', label: id, ...extra });
const rows = [st('a'), st('b'), st('c'), st('d')];
const ev = (stepId: string, state: RunStepEvent['state'], extra: Partial<RunStepEvent> = {}): RunStepEvent => ({ runId: 'r1', index: 0, stepId, state, ...extra });
const started = (): RunView => runReducer(runReducer(INITIAL_RUN, { type: 'prepare' }), { type: 'start', runId: 'r1', ids: ['a', 'b', 'c', 'd'], at: 1000 });

describe('run reducer', () => {
  it('starts with every step waiting', () => {
    const s = started();
    expect(s.phase).toBe('running');
    expect(Object.values(s.states)).toEqual(['waiting', 'waiting', 'waiting', 'waiting']);
  });
  it('follows running, looking and passed', () => {
    let s = started();
    s = runReducer(s, { type: 'step', ev: ev('a', 'running') });
    expect(s.currentId).toBe('a');
    s = runReducer(s, { type: 'step', ev: ev('a', 'passed') });
    s = runReducer(s, { type: 'step', ev: ev('b', 'looking') });
    expect(s.states).toMatchObject({ a: 'passed', b: 'looking' });
    expect(s.currentId).toBe('b');
  });
  it('ignores events from another run', () => {
    const s = runReducer(started(), { type: 'step', ev: { ...ev('a', 'passed'), runId: 'other' } });
    expect(s.states.a).toBe('waiting');
  });
  it('keeps the first failure (the child, not the loop around it) and marks the rest not run', () => {
    let s = started();
    s = runReducer(s, { type: 'step', ev: ev('c', 'failed', { reason: 'targetNotFound' }) });
    s = runReducer(s, { type: 'step', ev: ev('b', 'failed', { reason: 'targetNotFound' }) });
    s = runReducer(s, { type: 'ended', ev: { runId: 'r1', result: 'fail', durationMs: 5000, steps: [{ stepId: 'a', result: 'passed' }, { stepId: 'b', result: 'failed', reason: 'targetNotFound' }, { stepId: 'c', result: 'failed', reason: 'targetNotFound' }, { stepId: 'd', result: 'notRun' }] } });
    expect(s.phase).toBe('ended');
    expect(s.failedId).toBe('c');
    expect(s.states.d).toBe('notRun');
    expect(s.durationMs).toBe(5000);
  });
  it('records fixes and screenshots', () => {
    let s = runReducer(started(), { type: 'step', ev: ev('a', 'healed', { oldAt: [1, 2], newAt: [3, 4], screenshot: '/tmp/a.png' }) });
    expect(s.states.a).toBe('fixed');
    expect(s.fixes.a).toEqual({ oldAt: [1, 2], newAt: [3, 4] });
    s = runReducer(s, { type: 'ended', ev: { runId: 'r1', result: 'pass', durationMs: 1, steps: [{ stepId: 'a', result: 'healed' }] } });
    expect(s.steps![0].screenshotPath).toBe('/tmp/a.png');
    expect(s.states.b).toBe('passed');
  });
  it('shows an error that stops the run', () => {
    expect(runReducer(started(), { type: 'error', message: 'busy' })).toMatchObject({ phase: 'error', error: 'busy' });
  });
});

describe('tally and progress', () => {
  const states = { a: 'passed', b: 'fixed', c: 'failed', d: 'notRun' } as const;
  it('counts passed, fixed and failed rows, not loop frames or a stop', () => {
    expect(tally(states, rows)).toEqual({ passed: 1, fixed: 1, failed: 1 });
    expect(tally({ ...states, L: 'failed' }, [...rows, st('L', { action: 'loop', steps: [] })])).toEqual({ passed: 1, fixed: 1, failed: 1 });
    expect(tally(states, rows, { c: 'stopped' }).failed).toBe(0);
  });
  it('fills to the failed step, or by steps done', () => {
    expect(progress(states, rows)).toBe(0.75);
    expect(progress({ a: 'passed', b: 'running' }, rows)).toBe(0.25);
  });
  it('shows a stopped step as not run', () => {
    expect(rowStatus('failed', 'stopped')).toBe('notRun');
    expect(rowStatus('failed', 'timeout')).toBe('failed');
  });
  it('names the whole result', () => {
    expect(overall('pass', 0)).toBe('passed');
    expect(overall('pass', 1)).toBe('passedWithFixes');
    expect(overall('fail', 1)).toBe('failed');
  });
});

describe('focusStep', () => {
  it('opens on the failed step inside a loop, not the loop', () => {
    const flat = [st('a'), st('L', { action: 'loop', steps: [st('c')] }), st('c')];
    const run = { steps: [{ stepId: 'a', result: 'passed' as const }, { stepId: 'L', result: 'failed' as const }, { stepId: 'c', result: 'failed' as const }] };
    expect(focusStep(run, flat)?.stepId).toBe('c');
  });
  it('else opens on the first fixed step', () => {
    const run = { steps: [{ stepId: 'a', result: 'passed' as const }, { stepId: 'b', result: 'healed' as const }] };
    expect(focusStep(run, rows)?.stepId).toBe('b');
    expect(focusStep({ steps: [{ stepId: 'a', result: 'passed' }] }, rows)).toBeUndefined();
  });
});

describe('passes another way than the recording', () => {
  it('keeps how a step passed, from its event or the end of the run', async () => {
    const { passNote } = await import('./reasons');
    let s = started();
    s = runReducer(s, { type: 'step', ev: ev('a', 'passed', { passedBy: 'gone' }) });
    s = runReducer(s, { type: 'ended', ev: { runId: 'r1', result: 'pass', durationMs: 1, steps: [
      { stepId: 'a', result: 'passed', passedBy: 'gone' }, { stepId: 'b', result: 'passed', passedBy: 'note', why: 'The note says this closes it; it did, so this passed.' }] } });
    expect(passNote(s.passes.a)).toBe('Passed: the dialog closed. The page behind it looked different from when it was recorded.');
    expect(passNote(s.passes.b)).toBe('The note says this closes it; it did, so this passed.');
    expect(passNote(undefined)).toBeUndefined();
  });
});

describe('where a slow step\'s time went', () => {
  it('names the longest wait for a step over 2 s, and nothing for a quick one', async () => {
    const { slowNote } = await import('./reasons');
    expect(slowNote({ preMs: 5200, actionMs: 300, settleMs: 450, postMs: 150 }, 2)).toBe('Took 6.1 s: 5.2 s waiting for the page to finish changing after step 2.');
    expect(slowNote({ preMs: 10, actionMs: 200, settleMs: 2500, postMs: 30, settled: true })).toBe('Took 2.7 s: 2.5 s waiting for the page to settle after it.');
    expect(slowNote({ preMs: 10, actionMs: 100, settleMs: 8000, postMs: 30, settled: false })).toBe('Took 8.1 s: 8.0 s waiting for the page, which never stopped changing.');
    expect(slowNote({ preMs: 10, actionMs: 250, settleMs: 430, postMs: 40 })).toBeUndefined();
    expect(slowNote(undefined)).toBeUndefined();
    let s = started();
    s = runReducer(s, { type: 'step', ev: ev('b', 'passed', { timings: { preMs: 3000, actionMs: 10, settleMs: 400, postMs: 20 } }) });
    expect(s.timings.b.preMs).toBe(3000);
  });
});

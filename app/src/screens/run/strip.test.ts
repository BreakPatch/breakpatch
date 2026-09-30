import { describe, expect, it, vi } from 'vitest';
import type { Step } from '../../data/types';
import { DemoEngine } from '../../engine/demoEngine';
import type { RunStepEvent } from '../../engine';
import { INITIAL_RUN, runReducer, type RunView } from './runState';
import { hairline, rowNotes, runInfo, runStrip, stepCountText } from './strip';
import { demoFailIds } from './demo';

const st = (id: string, extra: Partial<Step> = {}): Step => ({ id, action: 'click', label: `Click ${id}`, target: `${id} button, top right`, ...extra });
const steps = [st('A'), { ...st('G', { action: 'group', label: 'Log in' }), steps: [st('g1'), st('g2')] }, st('Done', { at: [920, 634] })];
const info = runInfo(steps);
const base = (): RunView => runReducer(INITIAL_RUN, { type: 'start', runId: 'r', ids: ['A', 'G', 'g1', 'g2', 'Done'], at: 0 });
const step = (s: RunView, stepId: string, state: RunStepEvent['state'], reason?: RunStepEvent['reason']) => runReducer(s, { type: 'step', ev: { runId: 'r', index: 0, stepId, state, reason } });

describe('run strip', () => {
  it('shows the current step and "Step N of M" (a shared step counts as its card)', () => {
    const s = step(base(), 'g2', 'running');
    expect(runStrip(s, info)).toMatchObject({ title: 'Click g2', text: 'Step 2 of 3', motion: 'spin' });
    expect(stepCountText(s, info)).toBe('Step 2 of 3');
  });
  it('says the AI assistant is looking', () => {
    const s = step(base(), 'Done', 'looking');
    expect(runStrip(s, info).title).toBe('Looking for the Done button…');
    expect(rowNotes(s, info).Done).toBe('Looking for the button…');
  });
  it('explains a failure and where it stopped', () => {
    let s = step(base(), 'Done', 'failed', 'targetNotFound');
    s = runReducer(s, { type: 'ended', ev: { runId: 'r', result: 'fail', durationMs: 1, steps: [{ stepId: 'A', result: 'passed' }, { stepId: 'Done', result: 'failed', reason: 'targetNotFound' }] } });
    expect(runStrip(s, info)).toMatchObject({ title: "Couldn't find the Done button", text: 'The run stopped at step 3. See the report for what was expected.', tone: 'failed' });
    expect(stepCountText(s, info)).toBe('Stopped at step 3');
    expect(hairline(s, info)).toEqual({ value: 1, tone: 'failed' });
    expect(rowNotes(s, info).Done).toBe("Couldn't find the Done button");
  });
  it('puts a failure inside shared steps on the card', () => {
    const s = step(base(), 'g2', 'failed', 'timeout');
    expect(rowNotes(s, info).G).toBe('Step 2.2: Waited too long for the page');
  });
  it('says when everything worked', () => {
    const s = runReducer(base(), { type: 'ended', ev: { runId: 'r', result: 'pass', durationMs: 1, steps: [] } });
    expect(runStrip(s, info)).toMatchObject({ title: 'Passed', text: 'All 3 steps worked.' });
    expect(hairline(s, info)).toEqual({ value: 1, tone: 'passed' });
  });
});

describe('demo run', () => {
  it('fails at the seeded Click Done until it is re-recorded', () => {
    const seeded = st('s6', { label: 'Click Done', at: [920, 634] });
    expect(demoFailIds([st('a'), seeded])).toEqual(['s6']);
    expect(demoFailIds([st('a'), { ...seeded, pre: { region: [0, 0, 1, 1], hash: 'x', tolerance: 6 } }])).toEqual([]);
  });
  it('walks nested steps in pre-order and fails the child and its card', async () => {
    vi.useFakeTimers();
    const e = new DemoEngine();
    e.failStepIds = new Set(['g2']);
    const events: string[] = [];
    e.on('run.step', ev => events.push(`${ev.index}:${ev.stepId}:${ev.state}`));
    const ended = new Promise(res => e.on('run.ended', res));
    await e.startRun({ runId: 'r', startUrl: 'x', viewport: { width: 1440, height: 900, dpr: 1 }, steps, settings: { autoFix: false, failOnFix: false }, secrets: {} });
    await vi.runAllTimersAsync();
    const end = await ended as { result: string; steps: { stepId: string; result: string }[] };
    vi.useRealTimers();
    expect(events).toEqual(['0:A:running', '0:A:passed', '1:G:running', '2:g1:running', '2:g1:passed', '3:g2:running', '3:g2:failed', '1:G:failed']);
    expect(end.result).toBe('fail');
    expect(end.steps.map(s => `${s.stepId}:${s.result}`)).toEqual(['A:passed', 'G:failed', 'g1:passed', 'g2:failed', 'Done:notRun']);
  });
});

describe('the preview\'s "Why did this fail?"', () => {
  it('follows the explain feature, as the report\'s button does (not the edition\'s name)', async () => {
    const { resetFeaturesForTests, setFeatures } = await import('../../edition/features');
    const { NO_FEATURES } = await import('../../edition/types');
    const e = new DemoEngine();
    (e as unknown as { sleep: () => Promise<void> }).sleep = async () => undefined;
    const failed = { stepId: 'A', result: 'failed' as const, reason: 'targetNotFound' as const };
    setFeatures({ ...NO_FEATURES, explain: false });
    await expect(e.explain(st('A'), failed, { width: 1, height: 1 })).rejects.toMatchObject({ code: 'not_ready' });
    setFeatures({ ...NO_FEATURES, explain: true });
    expect(await e.explain(st('A'), failed, { width: 1, height: 1 })).toMatchObject({ cause: 'moved' });
    resetFeaturesForTests();
  });
});

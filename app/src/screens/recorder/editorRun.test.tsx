// Run and Play to here inside the recorder.
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step, Test } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { getEngine } from '../../engine';
import { StepsPanel } from '../../components/steps';
import { INITIAL_RUN, runReducer } from '../run/runState';
import { editorStatuses, useEditorRun } from './editorRun';
import { useRecorder } from './useRecorder';
import appSource from '../../App.tsx?raw';
import recorderSource from './RecorderScreen.tsx?raw';

Element.prototype.scrollIntoView ??= () => undefined;   // not in jsdom

const steps: Step[] = [
  { id: 'a', action: 'click', label: 'Click Sign in', at: [10, 10] },
  { id: 'L', action: 'loop', label: 'Repeat 2 times', count: 2, steps: [{ id: 'b', action: 'click', label: 'Click Add', at: [20, 20] }] },
  { id: 'c', action: 'click', label: 'Click Save', at: [30, 30] },
];
const test = { id: 't1', appId: 'app1', name: 'Sign in', startUrl: 'https://app.example.com', viewport: { width: 1440, height: 900, dpr: 1 }, currentVersion: 3 } as unknown as Test;

beforeEach(() => { useSession.setState({ backend: new DemoBackend({ empty: true, signedIn: true, delayMs: 0 }) }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('Run and Play to here in the recorder', () => {
  it('plays up to a step in the recorder\'s browser, keeps it open, and saves nothing', async () => {
    const spy = vi.spyOn(getEngine(), 'startRun');
    const backend = useSession.getState().backend!;
    const addRun = vi.spyOn(backend, 'addRun');
    const save = vi.spyOn(backend, 'saveTest');
    const { result } = renderHook(() => useEditorRun({ test, steps: () => steps }));
    let done: Awaited<ReturnType<typeof result.current.start>> = null;
    await act(async () => { done = await result.current.start('play', { upTo: 'b' }); });
    expect(spy.mock.calls[0][0]).toMatchObject({ keepOpen: true, upToStepId: 'b', startUrl: 'https://app.example.com' });
    expect(done).toMatchObject({ mode: 'play', result: 'pass', stoppedAt: 'b' });
    const { statuses } = editorStatuses(result.current.view, steps, 'play');
    expect(statuses).toEqual({ a: 'passed', L: 'passed', b: 'passed' });   // nothing on step 3: it didn't run
    expect(addRun).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('a full Run of the saved test goes in the run history, so its report opens', async () => {
    const backend = useSession.getState().backend!;
    const addRun = vi.spyOn(backend, 'addRun');
    const { result } = renderHook(() => useEditorRun({ test, steps: () => steps }));
    let done: Awaited<ReturnType<typeof result.current.start>> = null;
    await act(async () => { done = await result.current.start('run', { keepRun: true }); });
    expect(addRun).toHaveBeenCalledTimes(1);
    expect(done!.runId).toBeTruthy();
    expect(editorStatuses(result.current.view, steps, 'run').statuses.c).toBe('passed');
  });

  it('shows the failed step with why, and hides "Not run" after a Play to here', () => {
    let v = runReducer(runReducer(INITIAL_RUN, { type: 'prepare' }), { type: 'start', runId: 'r', ids: ['a', 'L', 'b', 'c'], at: 0 });
    v = runReducer(v, { type: 'step', ev: { runId: 'r', index: 0, stepId: 'a', state: 'passed' } });
    v = runReducer(v, { type: 'step', ev: { runId: 'r', index: 2, stepId: 'b', state: 'failed', reason: 'targetNotFound' } });
    v = runReducer(v, { type: 'ended', ev: { runId: 'r', result: 'fail', durationMs: 1, steps: [
      { stepId: 'a', result: 'passed' }, { stepId: 'L', result: 'failed', reason: 'targetNotFound' }, { stepId: 'b', result: 'failed', reason: 'targetNotFound' }, { stepId: 'c', result: 'notRun' }] } });
    const run = editorStatuses(v, steps, 'run');
    expect(run.statuses).toMatchObject({ a: 'passed', b: 'failed', c: 'notRun' });
    expect(run.notes.b).toBeTruthy();
    expect(editorStatuses(v, steps, 'play').statuses.c).toBeUndefined();
  });
});

describe('new steps go where the page is', () => {
  it('inserts after the chosen step, moves the insertion point on, and flags the steps after it', async () => {
    vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'n1', action: p.action, label: 'Click New', at: p.at }));
    const { result } = renderHook(() => useRecorder({ viewport: { width: 1440, height: 900 }, onError: vi.fn() }));
    act(() => { result.current.load(steps); result.current.setInsertAfter('a'); });
    act(() => { result.current.pagePoint([5, 5], 1); });
    await waitFor(() => expect(result.current.steps.map(s => s.id)).toEqual(['a', 'n1', 'L', 'c']));
    expect(result.current.insertAfterId).toBe('n1');
    expect([...result.current.unplayed].sort()).toEqual(['L', 'b', 'c']);
    act(() => { result.current.played({ full: true, at: 'c', insertAfter: null }); });
    expect(result.current.unplayed.size).toBe(0);
    expect(result.current.insertAfterId).toBeNull();
  });

  it('shows the insertion point, Play to here, Add a step after this one, and the not-played note', () => {
    const onPlayTo = vi.fn(), onAddAfter = vi.fn();
    const { container } = render(<StepsPanel steps={steps} mode="edit" selectedId="a" insertAfterId="a" unplayedIds={new Set(['c'])}
      onPlayTo={onPlayTo} onAddAfter={onAddAfter} onChange={() => undefined} onSelect={() => undefined} />);
    const next = container.querySelector('.step-next')!;
    expect(next.previousElementSibling?.getAttribute('data-step-id')).toBe('a');
    expect(container.querySelectorAll('.step-next')).toHaveLength(1);
    act(() => { screen.getByText('Play to here').click(); screen.getByText('Add a step after this one').click(); });
    expect(onPlayTo).toHaveBeenCalledWith('a');
    expect(onAddAfter).toHaveBeenCalledWith('a');
    expect(screen.getByText('Not played since the change. Run the test to check them.')).toBeInTheDocument();
  });

  it('keeps the run screen for runs started elsewhere, and the recorder no longer goes there', () => {
    expect(appSource).toContain('path="/apps/:appId/tests/:testId/run"');
    expect(recorderSource).not.toMatch(/tests\/\$\{testId\}\/run/);
  });
});

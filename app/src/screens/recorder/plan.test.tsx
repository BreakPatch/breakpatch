// "Write a test from a story" (Breakpatch Team, roadmap #10): the words of a story's steps, going
// through them in the recorder (find, Confirm, Try again, Skip, Edit, Stop) with the describe box's
// own flow, the floating card and the story dialog. The engine is the demo one, with spies.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DemoEngine } from '../../engine/demoEngine';
import { EngineError, getEngine, type Plan, type PlanStep } from '../../engine';
import { resetFeaturesForTests, setFeatures } from '../../edition/features';
import { NO_FEATURES } from '../../edition/types';
import { secrets } from '../../platform';
import { AddStepBar } from './AddStepBar';
import { CAREFUL_NOTE, answered, planDoneText, planIntent, planNeeds, planRun, planSentence } from './plan';
import { StoryDialog } from './StoryDialog';
import { useRecorder } from './useRecorder';
import RecorderScreen from './RecorderScreen';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { ToastProvider } from '../../components/ui';
import type { Step } from '../../data/types';

const vp = { width: 1440, height: 900 };
const PHONE = { width: 393, height: 659, device: 'iphone-15' };
const hook = (onError = vi.fn(), viewport: typeof vp | typeof PHONE = vp) => renderHook(() => useRecorder({ viewport, onError }));
Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetFeaturesForTests(); });

let located: string[];
let shows: boolean[];
beforeEach(() => {
  located = []; shows = [];
  vi.spyOn(getEngine(), 'locate').mockImplementation(async (what, opts) => {
    located.push(what); shows.push(!!opts?.shows);
    if (/missing/i.test(what)) return null;
    return { box: [100, 100, 300, 140], at: [200, 120], target: what, frame: 3, path: 'fast' };
  });
});
const recordPoint = () => vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: `s${Math.random()}`, action: p.action, label: `${p.action} step`, at: p.at, text: p.text, secretRef: p.secretRef }));

const SIGN_UP: PlanStep[] = [
  { action: 'write', target: 'the Name field', text: 'Ada Lovelace' },
  { action: 'write', target: 'the Password field', secretRef: 'TEST_PASSWORD' },
  { action: 'click', target: 'the Create account button' },
  { action: 'checkpoint', target: 'Account created' },
];

describe('a story’s steps in words', () => {
  it('says each step plainly', () => {
    expect(SIGN_UP.map(planSentence)).toEqual(['Type "Ada Lovelace" into the Name field', 'Type the saved secret TEST_PASSWORD into the Password field',
      'Click the Create account button', 'Check that Account created shows']);
    expect(planSentence({ action: 'write', generated: 'uniqueName' })).toBe('Type a unique name into the field that has the focus');
    expect(planSentence({ action: 'navigate', url: 'https://app.example.com' })).toBe('Go to https://app.example.com');
    expect(planSentence({ action: 'scroll', direction: 'up' })).toBe('Scroll up');
    expect(planSentence({ action: 'waitFor', seconds: 3 })).toBe('Wait 3 seconds');
    expect(planSentence({ action: 'hover', target: 'the Help menu' })).toBe('Hover over the Help menu');
    expect(planSentence({ action: 'write', target: 'the Email field', needs: 'text' })).toBe('Type into the Email field');
  });

  it('says what a typing step still needs', () => {
    expect(planNeeds({ action: 'write', target: 'the Password field', needs: 'secret' })).toMatch(/^Pick the saved secret to type here\. Breakpatch never makes up a password\.$/);
    expect(planNeeds({ action: 'write', target: 'Email', needs: 'text' })).toMatch(/^Say what to type here\./);
    expect(planNeeds(SIGN_UP[0])).toBeNull();
    expect(planNeeds(SIGN_UP[2])).toBeNull();
  });

  it('becomes the describe flow’s intent', () => {
    expect(planIntent(SIGN_UP[1])).toEqual({ action: 'write', target: 'the Password field', secretRef: 'TEST_PASSWORD', repeat: 1, from: 'plan' });
    expect(planIntent({ action: 'scroll' })).toMatchObject({ action: 'scroll', direction: 'down', distance: 300 });
    expect(planIntent({ action: 'navigate', url: 'https://x.example' })).toMatchObject({ action: 'navigate', url: 'https://x.example' });
  });

  it('counts what was added and skipped', () => {
    let run = planRun(SIGN_UP.slice(0, 3));
    run = answered(answered(answered(run, 0, 'done'), 1, 'skipped'), 2, 'done');
    expect(run.index).toBe(3);
    expect(planDoneText(run)).toBe('2 steps added, 1 skipped. Check them, then save the test.');
  });
});

describe('going through a story’s steps in the recorder', () => {
  it('finds each step, records it on Confirm, and moves on until the end', async () => {
    const point = recordPoint();
    vi.spyOn(secrets, 'resolve').mockResolvedValue({ TEST_PASSWORD: 'correct horse' });
    const check = vi.spyOn(getEngine(), 'recordCheckpoint').mockImplementation(async region => ({ id: 'c1', action: 'checkpoint', label: 'x', region, hash: '0', tolerance: 8 }));
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: SIGN_UP }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(result.current.ask).toBe('Is this the Name field? Confirm to type "Ada Lovelace" into it.');
    for (let i = 0; i < 3; i++) {
      act(() => { result.current.confirmAi(); });
      await waitFor(() => expect(result.current.plan?.index).toBe(i + 1));
      await waitFor(() => expect(result.current.ai.state).toBe('result'));
    }
    expect(point.mock.calls.map(c => c[0])).toEqual([
      { action: 'write', at: [200, 120], text: 'Ada Lovelace', target: 'the Name field', frame: 3 },
      { action: 'write', at: [200, 120], secretRef: 'TEST_PASSWORD', secrets: { TEST_PASSWORD: 'correct horse' }, target: 'the Password field', frame: 3 },
      { action: 'click', at: [200, 120], target: 'the Create account button', frame: 3 },
    ]);
    // The check looks for text that shows, and is named after it.
    expect(shows).toEqual([false, false, false, true]);
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.plan?.index).toBe(4));
    expect(check).toHaveBeenCalledWith([100, 100, 300, 140], 3);
    expect(result.current.steps.map(s => s.label).at(-1)).toBe('Account created shows');
    expect(result.current.plan?.steps.every(s => s.state === 'done')).toBe(true);
    expect(result.current.ai.state).toBe('idle');
    expect(result.current.dirty).toBe(true);                     // nothing is saved: the person saves
    expect(located).toEqual(['the Name field', 'the Password field', 'the Create account button', 'Account created']);
  });

  it('Skip leaves a step out, Try again looks again, Stop ends it', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: SIGN_UP.slice(2) }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    act(() => { result.current.retryAi(); });
    await waitFor(() => expect(located).toEqual(['the Create account button', 'the Create account button']));
    act(() => { result.current.skipPlanStep(); });
    await waitFor(() => expect(result.current.plan?.index).toBe(1));
    expect(result.current.plan?.steps[0].state).toBe('skipped');
    expect(point).not.toHaveBeenCalled();
    act(() => { result.current.stopPlan(); });
    expect(result.current.plan).toBeNull();
    expect(result.current.ai.state).toBe('idle');
  });

  it('a step it can’t find can be edited, then is looked for again', async () => {
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'the Missing button' }] }); });
    await waitFor(() => expect(result.current.ai.state).toBe('notfound'));
    expect(result.current.notFound).toBe('Couldn\'t find "the Missing button" on this screen. Click it on the page, edit the step, or skip it.');
    expect(result.current.text).toBe('');                             // the describe box is left alone
    act(() => { result.current.openPlanEdit(); });
    expect(result.current.planEditing).toBe(true);
    act(() => { result.current.editPlanStep({ target: 'Create account' }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(located).toEqual(['the Missing button', 'Create account']);
    expect(result.current.plan?.steps[0].target).toBe('Create account');
  });

  it('a click on the page shows where the current step is', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'the Missing button' }, { action: 'click', target: 'Next' }] }); });
    await waitFor(() => expect(result.current.ai.state).toBe('notfound'));
    vi.spyOn(getEngine(), 'propose').mockResolvedValue({ at: [50, 60] });
    act(() => { result.current.pagePoint([50, 60], 5); });
    expect(result.current.ai).toMatchObject({ state: 'proposal', plan: 0 });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.plan?.index).toBe(1));
    expect(point.mock.calls[0][0]).toMatchObject({ action: 'click', at: [50, 60], frame: 5 });
  });

  it('a typing step with no value waits for the person to say what to type', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'write', target: 'the Password field', needs: 'secret' }] }); });
    expect(result.current.planEditing).toBe(true);
    expect(located).toEqual([]);                                     // nothing looked for, nothing typed
    vi.spyOn(secrets, 'resolve').mockResolvedValue({ ADMIN: 'x' });
    act(() => { result.current.editPlanStep({ target: 'the Password field', secretRef: 'ADMIN' }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(result.current.plan?.steps[0]).toEqual({ action: 'write', target: 'the Password field', secretRef: 'ADMIN', state: 'todo' });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(point).toHaveBeenCalled());
    expect(point.mock.calls[0][0]).toMatchObject({ action: 'write', secretRef: 'ADMIN', secrets: { ADMIN: 'x' } });
  });

  it('says so when a step may delete, pay for or send something', async () => {
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'the Delete project button', careful: true }] }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(result.current.ask).toBe(`Is this the Delete project button? ${CAREFUL_NOTE}`);
  });

  it('a step that fails to record stays the current one', async () => {
    vi.spyOn(getEngine(), 'recordPoint').mockRejectedValue(new EngineError('stale', 'The page changed.'));
    const onError = vi.fn();
    const { result } = hook(onError);
    act(() => { result.current.startPlan({ steps: SIGN_UP.slice(2) }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The page changed.'));
    expect(result.current.plan?.index).toBe(0);
    expect(result.current.plan?.steps[0].state).toBe('todo');
  });
});

describe('a story on a phone or tablet, and while re-recording', () => {
  it('leaves out hover and right click steps on a touch test, and says Tap', async () => {
    const { result } = hook(vi.fn(), PHONE);
    act(() => { result.current.startPlan({ steps: [{ action: 'hover', target: 'the Help menu' }, { action: 'rightClick', target: 'the row' }, { action: 'click', target: 'Next' }], dropped: 1 }); });
    expect(result.current.plan?.steps.map(s => s.action)).toEqual(['click']);
    expect(result.current.plan?.dropped).toBe(3);
    expect(result.current.planText(result.current.plan!.steps[0])).toBe('Tap Next');
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(located).toEqual(['Next']);
  });

  it('keeps them on a desktop test', () => {
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'hover', target: 'the Help menu' }, { action: 'click', target: 'Next' }] }); });
    expect(result.current.plan?.steps.map(s => s.action)).toEqual(['hover', 'click']);
    expect(result.current.planText(result.current.plan!.steps[1])).toBe('Click Next');
  });

  it('adds a story’s steps as new steps, never over the step that was being re-recorded', async () => {
    const point = recordPoint();
    const kept: Step = { id: 'k1', action: 'click', label: 'Click Save', at: [10, 10] };
    const { result } = hook();
    act(() => { result.current.load([kept]); });
    act(() => { result.current.startRerecord('k1'); });
    expect(result.current.rerecordId).toBe('k1');
    // The first step is done at once (a wait), from the same render that still has k1 being re-recorded.
    act(() => { result.current.startPlan({ steps: [{ action: 'waitFor', seconds: 1 }, { action: 'click', target: 'Next' }] }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(1));
    expect(result.current.steps[0]).toEqual(kept);
    expect(result.current.steps.map(s => s.action)).toEqual(['click', 'waitFor']);
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.plan?.index).toBe(2));
    expect(result.current.steps[0]).toEqual(kept);
    expect(result.current.steps).toHaveLength(3);
    expect(point).toHaveBeenCalledTimes(2);
  });

  it('re-recording a step ends the story’s run', async () => {
    const { result } = hook();
    act(() => { result.current.load([{ id: 'k1', action: 'click', label: 'Click Save', at: [10, 10] }]); });
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'Next' }] }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    act(() => { result.current.startRerecord('k1'); });
    expect(result.current.plan).toBeNull();
    expect(result.current.ai.state).toBe('idle');
  });
});

describe('the describe box, end to end in the app', () => {
  it('says the AI assistant is missing instead of "Couldn’t find" when it’s needed and not downloaded', async () => {
    vi.spyOn(getEngine(), 'locate').mockRejectedValue(new EngineError('not_ready', "The AI assistant isn't downloaded yet. Finish setup to use it."));
    const { result } = hook();
    await act(async () => { await result.current.describe('click the shiny thing'); });
    expect(result.current.notFound).toBe("The AI assistant isn't downloaded yet. Finish setup to use it.");
  });

  it('looks for a described check as text that shows', async () => {
    const { result } = hook();
    await act(async () => { await result.current.describe('check that Account created shows'); });
    expect(located).toEqual(['Account created']);
    expect(shows).toEqual([true]);
  });
});

describe('the card and the bars', () => {
  function Bar({ plan }: { plan: Plan }) {
    const r = useRecorder({ viewport: vp, onError: vi.fn() });
    return <><button onClick={() => r.startPlan(plan)}>start</button><AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} /></>;
  }

  it('shows the step, Confirm, Try again, Skip and Edit, and the list of steps', async () => {
    render(<Bar plan={{ steps: SIGN_UP, note: 'The last check comes from your story.' }} />);
    fireEvent.click(screen.getByText('start'));
    expect(await screen.findByText('From your story · step 1 of 4')).toBeInTheDocument();
    expect(screen.getByText('The last check comes from your story.')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Confirm' });
    for (const name of ['Try again', 'Skip', 'Edit']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All steps' }));
    expect(screen.getAllByRole('listitem').map(li => li.querySelector('.grow')?.textContent)).toEqual(SIGN_UP.map(planSentence));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    expect(await screen.findByText('From your story · step 2 of 4')).toBeInTheDocument();
  });

  it('Edit opens a form for the step; Stop ends the story', async () => {
    render(<Bar plan={{ steps: [{ action: 'write', target: 'the Email field', needs: 'text' }] }} />);
    fireEvent.click(screen.getByText('start'));
    expect(await screen.findByText(/^Say what to type here\./)).toBeInTheDocument();
    const find = screen.getByRole('button', { name: 'Find it' });
    expect(find).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Text to type'), { target: { value: 'ada@example.com' } });
    fireEvent.click(find);
    await screen.findByRole('button', { name: 'Confirm' });
    expect(located).toEqual(['the Email field']);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Steps from your story' })).toBeNull());
  });
});

describe('the story dialog', () => {
  async function recorder(path = '') {
    const backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
    useSession.setState({ backend });
    const app = await backend.addApp({ name: 'Web', baseUrl: 'https://app.example.com', defaultViewport: { width: 1440, height: 900, dpr: 1 } });
    const t = await backend.createTest({ appId: app.id, name: 'Sign up', startUrl: 'https://app.example.com', viewport: { width: 1440, height: 900, dpr: 1 } });
    await backend.saveTest(app.id, t.id, [{ id: 'k1', action: 'click', label: 'Click Save', at: [10, 10] }]);
    render(<ToastProvider><MemoryRouter initialEntries={[`/apps/${app.id}/tests/${t.id}/record${path}`]}>
      <Routes><Route path="/apps/:appId/tests/:testId/record" element={<RecorderScreen />} /></Routes>
    </MemoryRouter></ToastProvider>);
    await screen.findByRole('button', { name: 'Run' });
  }

  it('is offered in the recorder only with the aiTests feature (Breakpatch Team)', async () => {
    await recorder();
    expect(screen.queryByRole('button', { name: 'From a story' })).toBeNull();
    cleanup();
    setFeatures({ ...NO_FEATURES, aiTests: true });
    await recorder();
    const from = await screen.findByRole('button', { name: 'From a story' });
    await waitFor(() => expect(from).toBeEnabled());
    vi.spyOn(secrets, 'list').mockResolvedValue([]);
    fireEvent.click(from);
    expect(await screen.findByRole('dialog', { name: 'Write a test from a story' })).toBeInTheDocument();
  });

  it('is turned off while a step is being re-recorded', async () => {
    setFeatures({ ...NO_FEATURES, aiTests: true });
    await recorder('?rerecord=k1');
    expect(await screen.findByText('Re-recording: do this step again on the page')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'From a story' })).toBeDisabled();
  });

  it('asks the engine with the story and only the picked secret names', async () => {
    vi.spyOn(secrets, 'list').mockResolvedValue(['TEST_PASSWORD', 'ADMIN_TOKEN']);
    const planSpy = vi.spyOn(getEngine(), 'plan').mockResolvedValue({ steps: SIGN_UP });
    const onPlan = vi.fn(), onClose = vi.fn();
    render(<StoryDialog open onClose={onClose} onPlan={onPlan} />);
    const make = screen.getByRole('button', { name: 'Make steps' });
    expect(make).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Your story'), { target: { value: 'Sign up, then I see Account created.' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'TEST_PASSWORD' }));
    fireEvent.click(make);
    await waitFor(() => expect(onPlan).toHaveBeenCalledWith({ steps: SIGN_UP }));
    expect(planSpy).toHaveBeenCalledWith('Sign up, then I see Account created.', ['TEST_PASSWORD']);
    expect(onClose).toHaveBeenCalled();
  });

  it('says why when there is no plan', async () => {
    vi.spyOn(secrets, 'list').mockResolvedValue([]);
    vi.spyOn(getEngine(), 'plan').mockRejectedValue(new EngineError('not_found', "The AI assistant couldn't make steps from this story. Try a shorter story, one action per sentence."));
    const onPlan = vi.fn();
    render(<StoryDialog open onClose={vi.fn()} onPlan={onPlan} />);
    expect(await screen.findByText(/No saved secrets on this Mac/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your story'), { target: { value: 'Do the thing.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make steps' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('one action per sentence');
    expect(onPlan).not.toHaveBeenCalled();
  });
});

describe('the demo engine (browser preview)', () => {
  it('plans only with the aiTests feature, like the Team engine', async () => {
    const demo = new DemoEngine();
    await expect(demo.plan('Create "Alpha"', [])).rejects.toMatchObject({ code: 'not_ready' });
    setFeatures({ ...NO_FEATURES, aiTests: true });
    vi.useFakeTimers();
    try {
      const got = demo.plan('Create a project called "Alpha"', []);
      await vi.advanceTimersByTimeAsync(2000);
      expect((await got).steps.map(s => s.action)).toEqual(['click', 'write', 'click', 'checkpoint']);
      expect((await got).steps[1].text).toBe('Alpha');
    } finally { vi.useRealTimers(); }
  });
});

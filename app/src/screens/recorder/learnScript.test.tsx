// Learning an imported script's steps in the recorder (roadmap #16): each step is found and done
// once, by itself, so its screen checks are recorded like a clicked step's; it stops at one it
// can't find or that needs a value, and Pause and Go on by itself switch that. The engine is the
// demo one, with spies.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEngine } from '../../engine';
import { secrets } from '../../platform';
import { AddStepBar } from './AddStepBar';
import { CHECK_NOTE, leftOutText, planDoneText, planHead, planIntent, planNeeds, planRun, planSentence, type WalkStep } from './plan';
import { useRecorder } from './useRecorder';
import { defaultLabel, StepsPanel } from '../../components/steps';
import type { Step } from '../../data/types';

const vp = { width: 1440, height: 900 };
const hook = (onError = vi.fn()) => renderHook(() => useRecorder({ viewport: vp, onError }));
Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

let located: string[];
beforeEach(() => {
  located = [];
  vi.spyOn(getEngine(), 'locate').mockImplementation(async what => {
    located.push(what);
    if (/missing/i.test(what)) return null;
    return { box: [100, 100, 300, 140], at: [200, 120], target: what, frame: 3, path: 'fast' };
  });
});
const recordPoint = () => vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: `s${Math.random()}`, action: p.action, label: `${p.action} step`, at: p.at, text: p.text, nav: p.nav, url: p.url }));

const SCRIPT: WalkStep[] = [
  { action: 'write', target: 'the "Email" field', text: 'ada@example.com' },
  { action: 'click', target: 'the "Sign in" button' },
  { action: 'navigate', nav: 'back' },
  { action: 'click', target: 'the "Docs" link' },
  { action: 'switchTab' },
  { action: 'waitUntil', target: '"Welcome"' },
];

describe('a script’s steps in words', () => {
  it('says the steps only a script has', () => {
    expect(planSentence({ action: 'navigate', nav: 'back' })).toBe('Go back');
    expect(planSentence({ action: 'navigate', nav: 'reload' })).toBe('Reload the page');
    expect(planSentence({ action: 'switchTab' })).toBe('Switch to the new tab');
    expect(planSentence({ action: 'waitUntil', target: '"Welcome"' })).toBe('Wait until "Welcome" shows');
    expect(planSentence({ action: 'write', target: 'the search field', text: '\n' })).toBe('Press Enter in the search field');
    expect(planSentence({ action: 'write', text: 'shoes\n' })).toBe('Type "shoes" into the field that has the focus and press Enter');
    expect(planIntent({ action: 'navigate', nav: 'forward' })).toMatchObject({ action: 'navigate', nav: 'forward' });
  });
  it('says what a script’s typing step needs in its own words', () => {
    expect(planNeeds({ action: 'write', target: 'x', needs: 'secret' }, 'script')).toMatch(/^The script takes this from a setting or the environment\./);
    expect(planNeeds({ action: 'write', target: 'x', needs: 'text' }, 'script')).toMatch(/^The script works this value out in code\./);
  });
  it('heads the card with what it’s doing, and counts what was learned', () => {
    const run = planRun(SCRIPT, undefined, 0, undefined, { source: 'script', auto: true });
    expect(planHead(run)).toBe('Learning step 1 of 6');
    expect(planHead({ ...run, auto: false })).toBe('From your script · step 1 of 6');
    expect(planHead(planRun(SCRIPT))).toBe('From your story · step 1 of 6');
    expect(planDoneText({ ...run, steps: run.steps.map((s, i) => ({ ...s, state: i ? 'done' : 'skipped' })), index: 6 })).toBe('5 steps learned, 1 skipped. Check them, then save the test.');
    expect(leftOutText({ source: 'script', dropped: 2 })).toBe("2 steps need a mouse (hover or right click), so they're left out on a phone or tablet.");
    expect(leftOutText({ source: 'script' })).toBeNull();
  });
});

describe('learning a script in the recorder', () => {
  it('does each step once, by itself, with no Confirm, and nothing is saved', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: SCRIPT.slice(0, 4) }, { source: 'script', auto: true }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(4));
    expect(point.mock.calls.map(c => c[0])).toEqual([
      { action: 'write', at: [200, 120], text: 'ada@example.com', target: 'the "Email" field', frame: 3 },
      { action: 'click', at: [200, 120], target: 'the "Sign in" button', frame: 3 },
      { action: 'navigate', nav: 'back' },
      { action: 'click', at: [200, 120], target: 'the "Docs" link', frame: 3 },
    ]);
    expect(result.current.steps).toHaveLength(4);
    expect(result.current.plan?.steps.every(s => s.state === 'done')).toBe(true);
    expect(result.current.dirty).toBe(true);
    expect(result.current.ai.state).toBe('idle');
  });

  it('switches to the new tab and waits until something shows', async () => {
    recordPoint();
    const wait = vi.spyOn(getEngine(), 'recordPoint');
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: SCRIPT.slice(4) }, { source: 'script', auto: true }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(2));
    expect(wait.mock.calls.map(c => c[0].action)).toEqual(['switchTab', 'waitUntil']);
    expect(wait.mock.calls[1][0]).toMatchObject({ region: [100, 100, 300, 140], timeoutMs: 10000 });
  });

  it('stops at a step it can’t find; Go on by itself looks again, Pause asks before each step', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'the Missing link' }, { action: 'click', target: 'Next' }, { action: 'click', target: 'Done' }] }, { source: 'script', auto: true }); });
    await waitFor(() => expect(result.current.ai.state).toBe('notfound'));
    expect(point).not.toHaveBeenCalled();
    // The person changes what to look for: it's found and, still learning, done at once.
    act(() => { result.current.editPlanStep({ target: 'Home' }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(3));
    expect(located).toEqual(['the Missing link', 'Home', 'Next', 'Done']);

    // Paused: the next one waits for Confirm.
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'Next' }, { action: 'click', target: 'Done' }] }, { source: 'script', auto: true }); });
    act(() => { result.current.setPlanAuto(false); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(result.current.plan?.index).toBe(0);
    expect(result.current.ask).toBe('Is this Next?');
    // Going on does the waiting step and the rest.
    act(() => { result.current.setPlanAuto(true); });
    await waitFor(() => expect(result.current.plan?.index).toBe(2));
  });

  it('a step marked Check always stops for Confirm, even going on by itself', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'Next' }, { action: 'write', target: 'the email field', text: 'a@b.c', check: true }, { action: 'click', target: 'Done' }] }, { source: 'script', auto: true }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(1));
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    expect(result.current.ask).toBe(`Is this the email field? Confirm to type "a@b.c" into it. ${CHECK_NOTE}`);
    act(() => { result.current.setPlanAuto(false); });
    act(() => { result.current.setPlanAuto(true); });
    await new Promise(r => setTimeout(r, 20));
    expect(point).toHaveBeenCalledTimes(1);                         // still waiting for Confirm
    expect(result.current.plan?.index).toBe(1);
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.plan?.index).toBe(3));   // and the rest go on by themselves
    expect(point).toHaveBeenCalledTimes(3);
  });

  it('a step marked Check goes on by itself once the person gives its words', async () => {
    const point = recordPoint();
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'submit button', check: true }] }, { source: 'script', auto: true }); });
    await waitFor(() => expect(result.current.ai.state).toBe('result'));
    act(() => { result.current.editPlanStep({ target: 'the Send button' }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(1));
    expect(point.mock.calls[0][0]).toMatchObject({ action: 'click', target: 'the Send button' });
  });

  it('a click on the page still asks while learning', async () => {
    const point = recordPoint();
    vi.spyOn(getEngine(), 'propose').mockResolvedValue({ at: [50, 60] });
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'click', target: 'the Missing button' }] }, { source: 'script', auto: true }); });
    await waitFor(() => expect(result.current.ai.state).toBe('notfound'));
    act(() => { result.current.pagePoint([50, 60], 5); });
    expect(result.current.ai).toMatchObject({ state: 'proposal', plan: 0 });
    await new Promise(r => setTimeout(r, 20));
    expect(point).not.toHaveBeenCalled();
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.plan?.index).toBe(1));
  });

  it('waits for a value the script works out in code, then goes on', async () => {
    const point = recordPoint();
    vi.spyOn(secrets, 'resolve').mockResolvedValue({ SHOP_PASSWORD: 'pw' });
    const { result } = hook();
    act(() => { result.current.startPlan({ steps: [{ action: 'write', target: 'the "Password" field', needs: 'secret' }, { action: 'click', target: 'Sign in' }] }, { source: 'script', auto: true }); });
    expect(result.current.planEditing).toBe(true);
    act(() => { result.current.editPlanStep({ target: 'the "Password" field', secretRef: 'SHOP_PASSWORD' }); });
    await waitFor(() => expect(result.current.plan?.index).toBe(2));
    expect(point.mock.calls[0][0]).toMatchObject({ action: 'write', secretRef: 'SHOP_PASSWORD', secrets: { SHOP_PASSWORD: 'pw' } });
  });
});

describe('the card while learning', () => {
  function Bar({ steps }: { steps: WalkStep[] }) {
    const r = useRecorder({ viewport: vp, onError: vi.fn() });
    return <><button onClick={() => r.startPlan({ steps, note: '2 lines of the script weren\'t imported.' }, { source: 'script', auto: true })}>start</button><AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} /></>;
  }

  it('says it is learning, with Pause, and Go on by itself once paused', async () => {
    recordPoint();
    render(<Bar steps={[{ action: 'click', target: 'the Missing link' }, { action: 'click', target: 'Next' }]} />);
    fireEvent.click(screen.getByText('start'));
    expect(await screen.findByRole('region', { name: 'Steps from your script' })).toBeInTheDocument();
    expect(screen.getByText('Learning step 1 of 2')).toBeInTheDocument();
    expect(screen.getByText("2 lines of the script weren't imported.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText('From your script · step 1 of 2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(screen.getByRole('button', { name: 'Go on by itself' }));
    expect(await screen.findByText(/^1 step learned, 1 skipped\./)).toBeInTheDocument();
  });
});

describe('a learned step that presses Enter', () => {
  it('is named for it', () => {
    expect(defaultLabel({ action: 'write', text: 'shoes\n' })).toBe('Write "shoes" and press Enter');
    expect(defaultLabel({ action: 'write', text: '\n' })).toBe('Press Enter');
  });

  it('keeps Enter when its text is edited', () => {
    const step: Step = { id: 'w', action: 'write', label: 'Write "shoes" and press Enter', text: 'shoes\n', at: [5, 5] };
    const onChange = vi.fn();
    render(<StepsPanel steps={[step]} mode="edit" selectedId="w" onChange={onChange} onSelect={() => undefined} onRerecord={() => undefined} onAddAfter={() => undefined} />);
    fireEvent.click(screen.getByLabelText('More for this step'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    const text = screen.getByLabelText('Text');
    expect(text).toHaveValue('shoes');
    fireEvent.change(text, { target: { value: 'boots' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls.at(-1)![0][0]).toMatchObject({ text: 'boots\n', label: 'Write "boots" and press Enter' });
  });
});

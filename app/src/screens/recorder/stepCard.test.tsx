// The open step card (#31), Edit (#26), What should happen (#30), Play this step (#27),
// passing steps losing their "Not played" note (#28), and a clean Run start (#24).
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Step, Test } from '../../data/types';
import { StepsPanel } from '../../components/steps';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { getEngine } from '../../engine';
import { useEditorRun } from './editorRun';
import { useRecorder } from './useRecorder';

Element.prototype.scrollIntoView ??= () => undefined;
beforeEach(() => { useSession.setState({ backend: new DemoBackend({ empty: true, signedIn: true, delayMs: 0 }) }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const steps: Step[] = [
  { id: 'a', action: 'click', label: 'Click Sign in', at: [10, 10], target: 'Sign in button' },
  { id: 'w', action: 'write', label: 'Write "qa@acme.example"', text: 'qa@acme.example' },
  { id: 'n', action: 'navigate', nav: 'url', label: 'Go to https://app.example.com/a', url: 'https://app.example.com/a' },
  { id: 't', action: 'waitFor', label: 'Wait 2 seconds', durationMs: 2000 },
];
const panel = (extra: Partial<Parameters<typeof StepsPanel>[0]> = {}) => {
  const onChange = vi.fn(), onEdited = vi.fn(), onPlayStep = vi.fn(), onPlayTo = vi.fn(), onRerecord = vi.fn(), onAddAfter = vi.fn();
  const r = render(<StepsPanel steps={steps} mode="edit" selectedId="a" onChange={onChange} onEdited={onEdited} onPlayStep={onPlayStep}
    onPlayTo={onPlayTo} onRerecord={onRerecord} onAddAfter={onAddAfter} onSelect={() => undefined} secretNames={['PW']} {...extra} />);
  return { ...r, onChange, onEdited, onPlayStep, onPlayTo, onRerecord, onAddAfter };
};

describe('the open step card', () => {
  it('has one row of actions and a ⋯ menu with Edit, Duplicate, Add a step after and Delete (confirmed)', () => {
    const p = panel();
    const row = p.container.querySelector('.step-actions')!;
    expect([...row.querySelectorAll('button')].map(b => b.textContent || b.getAttribute('aria-label')))
      .toEqual(['play_arrowPlay this step', 'play_arrowPlay to here', 'replayRe-record', 'more_vert']);
    expect(screen.getByLabelText('More for this step')).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.click(screen.getByText('Play this step'));
    expect(p.onPlayStep).toHaveBeenCalledWith('a');
    fireEvent.click(screen.getByLabelText('More for this step'));
    expect(screen.getAllByRole('menuitem').map(i => i.textContent)).toEqual(['editEdit', 'content_copyDuplicate', 'addAdd a step after', 'deleteDelete']);
    fireEvent.click(screen.getByRole('menuitem', { name: /Delete/ }));
    expect(p.onChange).not.toHaveBeenCalled();
    expect(screen.getByText('Delete step 1?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(p.onChange.mock.calls[0][0].map((s: Step) => s.id)).toEqual(['w', 'n', 't']);
  });

  it('sets What should happen with a chip and an optional note', () => {
    const p = panel();
    fireEvent.change(screen.getByLabelText(/What should happen/), { target: { value: 'closes' } });
    expect(p.onChange.mock.calls.at(-1)![0][0]).toMatchObject({ id: 'a', expect: 'closes' });
    fireEvent.click(screen.getByText('+ note'));
    const note = screen.getByPlaceholderText(/closes the What's new dialog/);
    fireEvent.change(note, { target: { value: "closes the What's new dialog" } });
    fireEvent.blur(note);
    expect(p.onChange.mock.calls.at(-1)![0][0]).toMatchObject({ expectNote: "closes the What's new dialog" });
  });

  it('offers "+" between steps, labelled for the keyboard', () => {
    const p = panel();
    const plus = screen.getAllByRole('button', { name: /^Add a step here, after step/ });
    expect(plus).toHaveLength(steps.length);
    fireEvent.click(plus[1]);
    expect(p.onAddAfter).toHaveBeenCalledWith('w');
  });

  it('hides the marker and the "+" while a test plays', () => {
    const p = panel({ locked: true, insertAfterId: 'a' });
    expect(p.container.querySelector('.step-next')).toBeNull();
    expect(screen.queryAllByTitle('Add a step here')).toHaveLength(0);
  });

  it('drops "Not played since the change" once the step shows as passed; no "Try it" crowding "Added"', () => {
    panel({ selectedId: null, unplayedIds: new Set(['w', 'n']), statuses: { w: 'passed', a: 'added' } });
    expect(screen.getAllByText('Not played since the change. Run the test to check them.')).toHaveLength(1);
    expect(screen.queryByText('Try it')).toBeNull();                 // Play this step does it (DESK-13)
  });
});

describe('Edit a step', () => {
  const edit = (id: string) => {
    const p = panel({ selectedId: id });
    fireEvent.click(screen.getByLabelText('More for this step'));
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    return p;
  };
  it('changes a Write to a saved secret, and flags the steps after it', () => {
    const p = edit('w');
    fireEvent.click(screen.getByRole('radio', { name: 'Saved secret' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onChange.mock.calls[0][0][1]).toMatchObject({ secretRef: 'PW', text: undefined, label: 'Write saved secret PW' });
    expect(p.onEdited).toHaveBeenCalledWith('w', true);
  });
  it('changes an address or a wait, renames, and Esc cancels', () => {
    let p = edit('n');
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'app.example.com/b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onChange.mock.calls[0][0][2]).toMatchObject({ url: 'https://app.example.com/b', label: 'Go to https://app.example.com/b' });
    p.unmount();
    p = edit('t');
    expect(screen.queryByLabelText('Name')).toBeNull();                      // a seconds wait shows only its seconds
    expect(screen.queryByLabelText(/What should happen/)).toBeNull();       // and has nothing to judge
    fireEvent.change(screen.getByLabelText('Seconds'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(p.onChange.mock.calls[0][0][3]).toMatchObject({ durationMs: 5000, label: 'Wait 5 seconds' });
    p.unmount();
    p = edit('a');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Click the big button' } });
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });
    expect(p.onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Edit step' })).toBeNull();
  });
});

describe('Play this step and a clean Run', () => {
  const test = { id: 't1', appId: 'app1', name: 'T', startUrl: 'https://app.example.com', viewport: { width: 1440, height: 900, dpr: 1 }, currentVersion: 1 } as unknown as Test;
  it('runs just that step on the page as it is', async () => {
    const spy = vi.spyOn(getEngine(), 'startRun');
    const { result } = renderHook(() => useEditorRun({ test, steps: () => steps }));
    let d: Awaited<ReturnType<typeof result.current.start>> = null;
    await act(async () => { d = await result.current.start('step', { upTo: 'w' }); });
    expect(spy.mock.calls[0][0]).toMatchObject({ keepOpen: true, fromStepId: 'w', upToStepId: 'w' });
    expect(d).toMatchObject({ mode: 'step', result: 'pass', stoppedAt: 'w', passedIds: ['w'] });
  });

  it('a run clears the selection and "Added", and passing steps lose their note', async () => {
    vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'z', action: p.action, label: 'Click here', at: p.at }));
    const { result } = renderHook(() => useRecorder({ viewport: { width: 1440, height: 900 }, onError: vi.fn() }));
    act(() => { result.current.load(steps); result.current.setInsertAfter('a'); });
    act(() => { result.current.pagePoint([5, 5], 1); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.addedId).toBe('z'));
    expect(result.current.unplayed.has('w')).toBe(true);
    act(() => { result.current.runStarted(); });
    expect(result.current.addedId).toBeNull();
    expect(result.current.selectedId).toBeNull();
    act(() => { result.current.played({ full: false, at: 'w', insertAfter: 'w', passed: ['a', 'z', 'w'] }); });
    expect([...result.current.unplayed].sort()).toEqual(['n', 't']);
    act(() => { result.current.edited('a', true); });
    expect(result.current.unplayed.has('w')).toBe(true);
  });
});

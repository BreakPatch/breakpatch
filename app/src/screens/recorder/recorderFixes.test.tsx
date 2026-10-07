// Recorder fixes from testing a real build: clicks carry the frame they were made on, the step's
// state reads plainly while it records, the AI bars float, and menu names stay on one line.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EngineError, getEngine, type Frame } from '../../engine';
import { fitScale, LiveView, toViewport } from '../../components/live';
import type { Step } from '../../data/types';
import { StepsPanel } from '../../components/steps';
import { ActionMenu } from './ActionMenu';
import { phaseText, useRecorder } from './useRecorder';
import liveSource from '../../components/live/LiveView.tsx?raw';

const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const here = dirname(fileURLToPath(import.meta.url));
const css = (p: string) => fs.readFileSync(join(here, p), 'utf8');

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
Element.prototype.scrollIntoView ??= () => undefined;   // not in jsdom
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const vp = { width: 1440, height: 900 };
const hook = (onError = vi.fn()) => renderHook(() => useRecorder({ viewport: vp, onError }));

describe('a click is recorded against the frame it was made on', () => {
  it('sends the frame with the click, and never keeps it in the step', async () => {
    const spy = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 's1', action: p.action, label: 'Click Next button', at: p.at }));
    const { result } = hook();
    act(() => { result.current.pagePoint([700, 500], 42); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toEqual({ action: 'click', at: [700, 500], frame: 42 });
    await waitFor(() => expect(result.current.steps[0]?.id).toBe('s1'));
    expect(result.current.steps[0]).not.toHaveProperty('frame');
    expect(result.current.addedId).toBe('s1');
  });

  it('drops the step and says why when the page had moved on', async () => {
    vi.spyOn(getEngine(), 'recordPoint').mockRejectedValue(new EngineError('stale', 'The page changed before your click reached it, so nothing was clicked. Look at the page again, then click.'));
    const onError = vi.fn();
    const { result } = hook(onError);
    act(() => { result.current.pagePoint([700, 500], 7); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining('nothing was clicked')));
    expect(result.current.steps).toHaveLength(0);
    expect(result.current.busy).toBe(false);
  });

  it('confirming an AI box clicks at once with the user\'s words and the frame the box was found on', async () => {
    vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [500, 480, 940, 528], at: [720, 504], target: 'the Next button', frame: 9 });
    const spy = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 's2', action: p.action, label: 'Click Next button', at: p.at, target: p.target }));
    const { result } = hook();
    await act(async () => { await result.current.describe('click the Next button'); });
    expect(result.current.ai.state).toBe('result');
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toEqual({ action: 'click', at: [720, 504], target: 'the Next button', frame: 9 });
    await waitFor(() => expect(result.current.steps[0]?.target).toBe('the Next button'));
  });

  it('says what the step is doing while it records', () => {
    expect(phaseText('watching', 'click')).toBe('Looking at the page…');
    expect(phaseText('acting', 'click')).toBe('Clicking…');
    expect(phaseText('acting', 'write')).toBe('Typing…');
    expect(phaseText('settling', 'click')).toBe('Waiting for the page…');
    expect(phaseText('reloading', 'click')).toBe('Waiting for the page…');
    expect(phaseText('naming', 'click')).toBe('Naming the step…');
  });
});

describe('step card states', () => {
  const steps: Step[] = [{ id: 'a', action: 'click', label: 'Click Sign in', at: [10, 10] }, { id: 'p', action: 'click', label: 'Click here', at: [20, 20] }];

  it('shows "Clicking…" on the step being recorded, with nothing to edit yet', () => {
    render(<StepsPanel steps={steps} mode="edit" selectedId="p" checkingId="p" statusTexts={{ p: 'Clicking…' }} onChange={() => undefined} onSelect={() => undefined} />);
    expect(screen.getByText('Clicking…')).toBeInTheDocument();
    expect(screen.queryByText('Re-record')).toBeNull();
    expect(screen.queryByText('What to look for')).toBeNull();
  });

  it('shows "Added" when it is saved, and says What to look for is optional and what it is for', () => {
    render(<StepsPanel steps={steps} mode="edit" selectedId="p" statuses={{ p: 'added' }} onChange={() => undefined} onSelect={() => undefined} onRerecord={() => undefined} />);
    expect(screen.getByText('Added')).toBeInTheDocument();
    // One short line, there before focus, so focusing adds no row and "+ note" stays put (DES-02).
    const help = screen.getByText('Optional. Helps find it if the page changes.');
    expect(help).toHaveAttribute('title', 'The dashed box on the page shows where this step acts.');
    const before = document.querySelectorAll('.step-edit *').length;
    fireEvent.focus(screen.getByLabelText(/What to look for/));
    expect(document.querySelectorAll('.step-edit *').length).toBe(before);
    fireEvent.click(screen.getByLabelText('More for this step'));
    expect(screen.getByRole('menuitem', { name: /Re-record/ })).toBeInTheDocument();
  });
});

describe('layout that must not move the page', () => {
  it('floats the AI bars over the page instead of taking space above the add step bar', () => {
    const rules = css('recorder.css');
    expect(rules).toMatch(/\.rec-float \{ position: absolute;[^}]*bottom: calc\(100% \+ 8px\)/);
    expect(rules).toMatch(/\.rec-hint \{[^}]*height: 18px; white-space: nowrap;/);
    // With no hint the row goes, and the bar keeps its height with the composer in the middle.
    expect(rules).toMatch(/\.rec-bar \{[^}]*min-height: 91px; justify-content: center;/);
    expect(rules).toContain('.rec-hint:empty { display: none; }');
  });

  it('keeps every action name on one line, next to its icon', () => {
    expect(css('recorder.css')).toMatch(/\.rec-menu \.menu-item \.grow \{ white-space: nowrap;/);
    expect(css('recorder.css')).toMatch(/\.rec-menu \{[^}]*min-width: 260px;/);
    render(<ActionMenu open current="waitUntil" allowGroups onPick={() => undefined} onClose={() => undefined} />);
    const item = screen.getByRole('menuitemradio', { name: /Wait until something appears/ });
    expect(item.firstElementChild).toHaveTextContent('hourglass_top');
    expect(item.children[1]).toHaveTextContent('Wait until something appears');
  });
});

describe('clicks map to true page pixels', () => {
  it('round-trips a click at every zoom and pane shape', () => {
    for (const pane of [{ width: 1300, height: 900 }, { width: 900, height: 1100 }, { width: 2400, height: 700 }]) {
      for (const zoom of [1, 0.86, 0.5, 1.5, fitScale(pane, vp)]) {
        for (const p of [[0, 0], [720, 450], [400, 396], [1439, 899]] as [number, number][]) {
          expect(toViewport({ x: p[0] * zoom, y: p[1] * zoom }, zoom, vp)).toEqual(p);
        }
      }
    }
  });

  it('stamps a press with the frame on screen, and draws a frame at its own size, never stretched', () => {
    const engine = getEngine() as unknown as { emit(e: 'frame', d: Frame): void };
    const onPoint = vi.fn();
    const { container } = render(<LiveView address="x" viewport={vp} source="frames" onPoint={onPoint} />);
    act(() => { engine.emit('frame', { jpeg: '/9j/', width: 1440, height: 900, seq: 5 }); });
    const img = container.querySelector('img.live-img') as HTMLImageElement;
    expect(img.style.height).toBe('');                       // the viewport's size: fills the page box
    const hit = container.querySelector('.live-hit')!;
    fireEvent.pointerDown(hit, { button: 0, clientX: 100, clientY: 80 });
    act(() => { engine.emit('frame', { jpeg: '/9j/', width: 1440, height: 812, seq: 6 }); });
    fireEvent.pointerUp(hit, { button: 0, clientX: 100, clientY: 80 });
    expect(onPoint).toHaveBeenCalledTimes(1);
    expect(onPoint.mock.calls[0][1]).toBe(5);                // the frame the press began on
    expect(img.style.height).toBe('812px');                  // a short frame keeps its own size
  });

  it('shows why the page is not taking clicks, and does nothing', () => {
    const onPoint = vi.fn();
    const { container } = render(<LiveView address="x" viewport={vp} source="sample" onPoint={onPoint} blocked="Wait for step 2 to finish, then click." />);
    const hit = container.querySelector('.live-hit')!;
    fireEvent.pointerDown(hit, { button: 0, clientX: 100, clientY: 80 });
    fireEvent.pointerUp(hit, { button: 0, clientX: 100, clientY: 80 });
    expect(onPoint).not.toHaveBeenCalled();
    expect(screen.getByText('Wait for step 2 to finish, then click.')).toBeInTheDocument();
  });
});

describe('nothing under or over the page moves it', () => {
  it('keeps the add step bar to the hint and the composer for every action; the rest floats', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    const { menuGroups } = await import('./actions');
    const { result } = hook();
    for (const item of menuGroups({ allowGroups: true }).flatMap(g => g.items)) {
      if (item.nav || item.kind === 'group') continue;
      act(() => { result.current.setAction(item.kind); });
      const { container, unmount } = render(<AddStepBar rec={result.current} appId="a" allowGroups describe onInsertGroup={() => undefined} />);
      const inFlow = [...container.querySelector('.rec-bar')!.children].map(c => c.className.split(' ')[0]);
      expect(inFlow, item.kind).toEqual(['rec-float', 'rec-hint', 'rec-composer-wrap']);
      unmount();
    }
    expect(css('recorder.css')).toMatch(/\.rec-float \{ position: absolute;/);
  });
});

describe('a failed step says why in full', () => {
  const steps: Step[] = [{ id: 'a', action: 'click', label: 'Click Next button', at: [10, 10] }];
  const why = 'The step was done, but nothing changed on the page the way it did when it was recorded.';
  it('wraps the whole reason when the card is open, and keeps it on hover when closed', () => {
    const { container, rerender } = render(<StepsPanel steps={steps} mode="edit" selectedId="a" statuses={{ a: 'failed' }} notes={{ a: why }} onChange={() => undefined} onSelect={() => undefined} />);
    let note = container.querySelector('.step-note')!;
    expect(note).toHaveTextContent(why);
    expect(note.className).toContain('full');
    expect(css('../../components/steps/steps.css')).toMatch(/\.step-note\.full \{ white-space: normal;/);
    rerender(<StepsPanel steps={steps} mode="run" statuses={{ a: 'failed' }} notes={{ a: why }} />);
    note = container.querySelector('.step-note')!;
    expect(note.className).not.toContain('full');
    expect(note.getAttribute('title')).toBe(why);
  });
});

describe('nothing reaches the page until it is confirmed', () => {
  it('a click on the page only proposes the step, named, and Confirm records it', async () => {
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 's9', action: p.action, label: p.label ?? 'Click here', at: p.at, target: p.target }));
    const prop = vi.spyOn(getEngine(), 'propose').mockResolvedValue({ at: [700, 500], box: [600, 480, 800, 520], name: 'Next button', target: 'Next button, under the email field' });
    const { result } = hook();
    act(() => { result.current.pagePoint([700, 500], 3); });
    expect(result.current.ai.state).toBe('proposal');
    expect(result.current.ask).toBe('Click here?');
    await waitFor(() => expect(result.current.ask).toBe('Click Next button?'));
    expect(prop).toHaveBeenCalledWith([700, 500]);
    expect(rec).not.toHaveBeenCalled();                                   // nothing was clicked yet
    act(() => { result.current.pagePoint([610, 490], 4); });              // the same thing again: confirms
    await waitFor(() => expect(rec).toHaveBeenCalledTimes(1));
    expect(rec.mock.calls[0][0]).toEqual({ action: 'click', at: [700, 500], frame: 3, target: 'Next button, under the email field', label: 'Click Next button' });
    await waitFor(() => expect(result.current.steps[0]?.label).toBe('Click Next button'));
  });

  it('Cancel and Try again leave the page alone', () => {
    const rec = vi.spyOn(getEngine(), 'recordPoint');
    vi.spyOn(getEngine(), 'propose').mockResolvedValue({ at: [1, 1] });
    const { result } = hook();
    act(() => { result.current.pagePoint([10, 10], 1); });
    act(() => { result.current.cancelAi(); });
    expect(result.current.ai.state).toBe('idle');
    act(() => { result.current.pagePoint([10, 10], 1); });
    act(() => { result.current.retryAi(); });
    expect(result.current.ai.state).toBe('idle');
    expect(result.current.retryNote).toBe(true);
    expect(rec).not.toHaveBeenCalled();
  });

  it('scrolling over the page proposes a scroll step instead of scrolling it', () => {
    const pointer = vi.spyOn(getEngine(), 'pointer');
    const { result } = hook();
    act(() => { result.current.pageScroll([400, 300], 0, 120, 2); });
    act(() => { result.current.pageScroll([400, 300], 0, 180, 2); });
    expect(result.current.ai.state).toBe('proposal');
    expect(result.current.ask).toBe('Scroll down 300 px?');
    expect(pointer).not.toHaveBeenCalled();
  });

  it('the live view sends nothing to the engine for a wheel', () => {
    const pointer = vi.spyOn(getEngine(), 'pointer');
    const onScroll = vi.fn();
    const { container } = render(<LiveView address="x" viewport={vp} source="sample" onScroll={onScroll} />);
    fireEvent.wheel(container.querySelector('.live-hit')!, { deltaY: 100 });
    expect(pointer).not.toHaveBeenCalled();
    expect(liveSource).not.toMatch(/\.pointer\(/);
  });
});

describe("a click that opens the page's file picker", () => {
  it('asks which file and sends the answer; uploads of own files come from the tests folder', async () => {
    const engine = getEngine() as unknown as { emit(e: 'record.fileChooser', d: { accept: string; multiple: boolean }): void };
    let release: () => void = () => undefined;
    vi.spyOn(getEngine(), 'recordPoint').mockImplementation(p => new Promise(res => { release = () => res({ id: 'u1', action: 'upload', label: 'Upload photo.jpg', at: p.at, file: 'files/photo.jpg' }); }));
    const choose = vi.spyOn(getEngine(), 'chooseFile').mockResolvedValue();
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn(), filesDir: '/t/files' }));
    act(() => { result.current.pagePoint([100, 60], 1); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(getEngine().recordPoint).toHaveBeenCalled());
    expect(vi.mocked(getEngine().recordPoint).mock.calls[0][0]).toMatchObject({ filesDir: '/t/files' });
    act(() => { engine.emit('record.fileChooser', { accept: 'image/*', multiple: false }); });
    expect(result.current.fileAsk).toEqual({ accept: 'image/*', multiple: false });
    act(() => { result.current.chooseFile({ file: 'files/photo.jpg', path: '/t/files/photo.jpg' }); });
    expect(choose).toHaveBeenCalledWith({ file: 'files/photo.jpg', path: '/t/files/photo.jpg' });
    expect(result.current.fileAsk).toBeNull();
    act(() => release());
    await waitFor(() => expect(result.current.steps[0]?.file).toBe('files/photo.jpg'));
  });
});

describe('a password typed as plain text', () => {
  const masked = () => vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'w1', action: 'write', label: 'Write "••••••••"', text: p.text, masked: true }));
  const typeIt = async (r: { current: ReturnType<typeof useRecorder> }) => {
    act(() => { r.current.setAction('write'); r.current.setText('hunter2!'); });
    act(() => { r.current.send(); });
    await waitFor(() => expect(r.current.steps[0]?.id).toBe('w1'));
  };

  it('shows as dots, offers once to save it as a saved secret, and then uses the secret', async () => {
    masked();
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn(), appUrl: 'https://app.example.com', appId: 'web' }));
    await typeIt(result);
    expect(result.current.steps[0].label).toBe('Write "••••••••"');
    expect(result.current.secretAsk?.id).toBe('w1');
    await act(async () => { await result.current.saveAsSecret('SIGNUP_PASSWORD'); });
    expect(result.current.steps[0]).toMatchObject({ secretRef: 'SIGNUP_PASSWORD', label: 'Write saved secret SIGNUP_PASSWORD' });
    expect(result.current.steps[0].text).toBeUndefined();
    const { secrets } = await import('../../platform');
    expect(await secrets.resolve(['SIGNUP_PASSWORD'])).toEqual({ SIGNUP_PASSWORD: 'hunter2!' });
    expect((await secrets.info()).find(s => s.name === 'SIGNUP_PASSWORD')?.origins).toEqual(['https://app.example.com']);
    expect(result.current.secretAsk).toBeNull();
  });

  it('can stay typed text, and stop asking for this app', async () => {
    masked();
    const { useSession } = await import('../../state/session');
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn(), appId: 'sandbox' }));
    await typeIt(result);
    act(() => { result.current.keepTyped(true); });
    expect(result.current.secretAsk).toBeNull();
    expect(result.current.steps[0].text).toBe('hunter2!');
    expect(useSession.getState().prefs.noSecretAsk).toContain('sandbox');
    const again = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn(), appId: 'sandbox' }));
    await typeIt(again.result);
    expect(again.result.current.secretAsk).toBeNull();
  });

  it('the list shows dots, and the eye shows the typed text', () => {
    const steps: Step[] = [{ id: 'w', action: 'write', label: 'Write "••••••••"', text: 'hunter2!', masked: true }];
    render(<StepsPanel steps={steps} mode="edit" onChange={() => undefined} onSelect={() => undefined} />);
    expect(screen.getByText('Write "••••••••"')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Show the typed text'));
    expect(screen.getByText('Write "hunter2!"')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Hide the typed text'));
    expect(screen.queryByText('Write "hunter2!"')).toBeNull();
  });
});

describe('a file picker that opens after the click was answered', () => {
  it('asks, and turns the recorded click into an upload', async () => {
    const engine = getEngine() as unknown as { emit(e: string, d: unknown): void };
    vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'k1', action: 'click', label: 'Click Add photo', at: p.at, target: 'Add photo' }));
    const choose = vi.spyOn(getEngine(), 'chooseFile').mockResolvedValue();
    const { result } = hook();
    act(() => { result.current.pagePoint([100, 60], 1); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.steps[0]?.id).toBe('k1'));
    expect(result.current.busy).toBe(false);
    act(() => { engine.emit('record.fileChooser', { accept: 'image/*', multiple: false, stepId: 'k1' }); });
    expect(result.current.fileAsk?.stepId).toBe('k1');
    act(() => { result.current.chooseFile({ sample: 'jpeg' }); });
    expect(choose).toHaveBeenCalledWith({ sample: 'jpeg' });
    act(() => { engine.emit('record.stepChanged', { step: { id: 'k1', action: 'upload', sample: 'jpeg', label: 'Upload JPEG image', at: [100, 60] } }); });
    expect(result.current.steps[0]).toMatchObject({ id: 'k1', action: 'upload', sample: 'jpeg', label: 'Upload JPEG image', target: 'Add photo' });
  });
});

describe('the Enter that sends a sentence never confirms it too (DES2-01)', () => {
  it('pressing Enter in the describe box shows the proposal and waits; a new Enter confirms it', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    const confirm = vi.fn();
    function Bar() {
      const rec = useRecorder({ viewport: vp, onError: vi.fn() });
      return <AddStepBar rec={{ ...rec, confirmAi: () => { confirm(); rec.confirmAi(); } }} appId="a" allowGroups describe onInsertGroup={() => undefined} />;
    }
    const { container } = render(<Bar />);
    const box = screen.getByLabelText('Describe the next step');
    fireEvent.change(box, { target: { value: 'enter the password' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(container.querySelector('.rec-ai-result')).not.toBeNull());
    expect(container.querySelector('.rec-ai-result')!.textContent).toMatch(/the password/);
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(confirm).not.toHaveBeenCalled();                                   // the same Enter didn't answer it
    fireEvent.keyDown(window, { key: 'Enter', repeat: true });                // a held Enter's repeats don't either
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'Enter' });                              // a deliberate one does
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe('Try again and what the box can\'t do (DES2-09, DES2-11)', () => {
  it('Try again on a described step puts the sentence back in the box, and says nothing about clicking the page', () => {
    const { result } = hook();
    act(() => { void result.current.describe('type hello 3 times'); });
    expect(result.current.ai.state).toBe('proposal');
    act(() => { result.current.retryAi(); });
    expect(result.current.ai.state).toBe('idle');
    expect(result.current.text).toBe('type hello 3 times');
    expect(result.current.retryNote).toBe(false);
    expect(result.current.refocus).toBeGreaterThan(0);
  });

  it('"click the page again" goes once anything else is asked', () => {
    vi.spyOn(getEngine(), 'propose').mockResolvedValue({ at: [1, 1] });
    const { result } = hook();
    act(() => { result.current.pagePoint([10, 10], 1); });
    act(() => { result.current.retryAi(); });
    expect(result.current.retryNote).toBe(true);
    act(() => { void result.current.describe('type hello'); });
    expect(result.current.retryNote).toBe(false);
  });

  it('shows what the box can\'t do by the box, until the sentence changes', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    function Bar() {
      const rec = useRecorder({ viewport: vp, onError: vi.fn() });
      return <AddStepBar rec={rec} appId="a" allowGroups describe onInsertGroup={() => undefined} />;
    }
    render(<Bar />);
    const box = screen.getByLabelText('Describe the next step');
    fireEvent.change(box, { target: { value: 'wait for the spinner to go away' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(await screen.findByText(/can't wait for something to go away/)).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'wait for the spinner' } });
    expect(screen.queryByText(/can't wait for something to go away/)).toBeNull();
  });
});

describe('where a described typing step will type (DES2-10)', () => {
  it('outlines and names the field that has the focus', async () => {
    vi.spyOn(getEngine(), 'focused').mockResolvedValue({ box: [10, 20, 210, 50], name: 'Email' });
    const { result } = hook();
    act(() => { void result.current.describe('type hello'); });
    await waitFor(() => expect(result.current.ask).toBe('Write "hello" into Email?'));
    expect(result.current.ai).toMatchObject({ state: 'proposal', box: [10, 20, 210, 50] });
  });

  it('says so when no field has the focus', async () => {
    vi.spyOn(getEngine(), 'focused').mockResolvedValue({ box: null, name: null });
    const { result } = hook();
    act(() => { void result.current.describe('type hello 2 times'); });
    await waitFor(() => expect(result.current.ask).toBe('Write "hello", 2 times? No field is selected: click the field first.'));
  });
});

describe('the describe box (DESCRIBE_STEPS)', () => {
  it('is on: clicking and describing are both there', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    function Bar() {
      const r = useRecorder({ viewport: vp, onError: vi.fn() });
      return <AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} />;
    }
    render(<Bar />);
    expect(screen.getByLabelText('Describe the next step')).toBeInTheDocument();
    expect(screen.getByText(/Click anything on the page to add a step, or describe it below/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask the AI assistant' })).toBeInTheDocument();
  });
});

describe('with the describe box off (DESCRIBE_STEPS false)', () => {
  it('has no describe box: on-page actions say what to do on the page, Write keeps its box', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    let r!: ReturnType<typeof useRecorder>;
    function Bar() {
      r = useRecorder({ viewport: vp, onError: vi.fn() });
      return <AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} describe={false} />;
    }
    render(<Bar />);
    expect(screen.queryByLabelText('Describe the next step')).toBeNull();
    // One instruction, in the bar; no hint row repeating it, no send button with nothing to send.
    expect(screen.getByText('Click on the page to add a step.')).toBeInTheDocument();
    expect(screen.queryByText(/describe it/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add step' })).toBeNull();
    act(() => { r.setAction('waitUntil'); });
    expect(screen.getAllByText(/Draw a box around what should appear/)).toHaveLength(1);
    expect(screen.getByLabelText('Maximum wait in seconds').closest('.rec-composer')).not.toBeNull();   // in the bar, not over the page
    act(() => { r.setAction('write'); });
    expect(screen.getByLabelText('Text to write')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add step' })).toBeInTheDocument();
  });

  it('says what each gesture needs, keeps Upload file’s words whole above its file choice, and shows each icon once', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    let r!: ReturnType<typeof useRecorder>;
    function Bar() {
      r = useRecorder({ viewport: vp, onError: vi.fn() });
      return <AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} describe={false} />;
    }
    const { container } = render(<Bar />);
    // Nothing to type: no field look, and no icon in front repeating the action button's.
    expect(container.querySelector('.rec-composer.passive .rec-lead')).toBeNull();
    expect(container.querySelector('.rec-hint')).toBeEmptyDOMElement();
    for (const [kind, words] of [['doubleClick', 'Click what to double-click on the page.'], ['rightClick', 'Click what to right-click on the page.'], ['longClick', /^Click what to long-click on the page\./]] as const) {
      act(() => { r.setAction(kind); });
      expect(screen.getByText(words)).toBeInTheDocument();
    }
    act(() => { r.setAction('upload'); });
    expect(container.querySelector('.rec-hint')).toHaveTextContent('Pick a file, then click the upload field on the page.');
    expect(container.querySelector('.rec-composer')).not.toHaveTextContent('click the upload field');
    expect(screen.getByRole('radiogroup', { name: 'Sample file' }).closest('.rec-composer')).not.toBeNull();
    // Its own icon, not Double click's.
    expect(container.querySelector('.rec-hint .icon')).not.toHaveTextContent('ads_click');
    act(() => { r.setAction('swipe'); });
    expect(container.querySelector('.rec-hint')).not.toHaveTextContent('swipe');   // not the swipe icon again
    expect(container.querySelector('.rec-hint .icon')).not.toHaveTextContent('drag_pan');   // nor Drag and drop's
    // One clear way: a drag sets direction and distance, a click uses the fields.
    expect(container.querySelector('.rec-hint')).toHaveTextContent('Drag on the page to set the direction and distance, or click it to use the ones below.');
    expect(container.querySelector('.rec-hint')).not.toHaveTextContent('length of the drag');
  });

  it('while the test plays, the bar says so instead of how to add a step (DESK-06)', async () => {
    const { AddStepBar } = await import('./AddStepBar');
    function Bar() {
      const r = useRecorder({ viewport: vp, onError: vi.fn() });
      return <AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} frozen="The test is playing in this browser." />;
    }
    const { container } = render(<Bar />);
    expect(container.querySelector('.rec-composer')).toHaveTextContent('The test is playing in this browser.');
    expect(screen.queryByText('Click on the page to add a step.')).toBeNull();
    expect(screen.getAllByText('The test is playing in this browser.')).toHaveLength(1);
  });
});

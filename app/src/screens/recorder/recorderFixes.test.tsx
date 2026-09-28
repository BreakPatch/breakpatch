// Recorder fixes from testing a real build: clicks carry the frame they were made on, the step's
// state reads plainly while it records, the AI bars float, and menu names stay on one line.
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
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

afterEach(() => { vi.restoreAllMocks(); });
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
    expect(screen.queryByText(/The dashed box on the page/)).toBeNull();          // the helper shows only while editing
    fireEvent.focus(screen.getByLabelText(/What to look for/));
    expect(screen.getByText(/Optional\. Helps find it again.*The dashed box on the page shows where this step acts/)).toBeInTheDocument();
    expect(screen.getByText('Re-record')).toBeInTheDocument();
  });
});

describe('layout that must not move the page', () => {
  it('floats the AI bars over the page instead of taking space above the add step bar', () => {
    const rules = css('recorder.css');
    expect(rules).toMatch(/\.rec-float \{ position: absolute;[^}]*bottom: calc\(100% \+ 8px\)/);
    expect(rules).toMatch(/\.rec-hint \{[^}]*height: 18px; white-space: nowrap;/);
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
      const { container, unmount } = render(<AddStepBar rec={result.current} appId="a" allowGroups onInsertGroup={() => undefined} />);
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

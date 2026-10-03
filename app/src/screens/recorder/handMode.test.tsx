// #35 Play this step plays up to the step before it by itself; #36 "Use the page".
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '../../data/types';
import { getEngine } from '../../engine';
import { LiveView } from '../../components/live/LiveView';
import { keyName } from '../../components/live/geometry';
import { StepsPanel } from '../../components/steps';
import { setOsForTests } from '../../lib/osWords';
import { addStepHint } from './editorRun';
import screenSource from './RecorderScreen.tsx?raw';
import { useRecorder } from './useRecorder';

Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const vp = { width: 800, height: 600 };

describe('Play this step and Add a step here never play other steps', () => {
  it('Play this step runs only that step, on the page as it is', () => {
    const body = screenSource.slice(screenSource.indexOf('const playStep = async'), screenSource.indexOf('const addAfter'));
    expect(body).toContain("play('step', id)");
    expect(body).not.toContain("play('play'");
    const add = screenSource.slice(screenSource.indexOf('const addAfter'), screenSource.indexOf('const { statuses'));
    expect(add).not.toMatch(/void play\('play', id\)\.then|await play/);      // only from the hint's button
  });
  it('Add a step here only hints when the page is elsewhere, with Play to here', () => {
    expect(addStepHint('b', 'd', false, 4)).toBe("The page isn't at step 4. Use Play to here, or Use the page, to get it there.");
    expect(addStepHint('d', 'd', false, 4)).toBeNull();                   // the page is there
    expect(addStepHint(null, 'd', true, 4)).toBeNull();                   // set up by hand: the user knows
    expect(screenSource).toContain("action: { label: 'Play to here'");
  });
  it('has no "Play on the page as it is" any more: Play this step is that', () => {
    const steps: Step[] = [{ id: 'a', action: 'click', label: 'Click A', at: [1, 1] }];
    const r = render(<StepsPanel steps={steps} mode="edit" selectedId="a" onPlayStep={() => undefined} onChange={() => undefined} onSelect={() => undefined} />);
    fireEvent.click(r.getByLabelText('More for this step'));
    expect(r.queryByRole('menuitem', { name: /as it is/ })).toBeNull();
  });
});

describe('Use the page', () => {
  it('sends mouse, wheel and keys straight to the page, and nothing to the recorder', () => {
    const onInput = vi.fn(), onPoint = vi.fn();
    const r = render(<LiveView address="x" viewport={vp} source="sample" passThrough onInput={onInput} onPoint={onPoint} />);
    const hit = r.container.querySelector('.live-hit')!;
    expect(r.container.querySelector('.live.hand')).not.toBeNull();       // the coloured ring
    fireEvent.pointerDown(hit, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(hit, { button: 0, clientX: 10, clientY: 10 });
    fireEvent.wheel(hit, { deltaY: 120 });
    fireEvent.keyDown(hit, { key: 'a' });
    fireEvent.keyDown(hit, { key: 'Enter' });
    fireEvent.keyDown(hit, { key: 'Escape' });                          // Esc goes to the page too
    fireEvent.keyDown(hit, { key: 'e', metaKey: true });               // Cmd+E doesn't: it leaves the mode
    expect(onInput.mock.calls.map(c => c[0].kind)).toEqual(['down', 'up', 'wheel', 'text', 'key', 'key']);
    expect(onInput.mock.calls[3][0]).toEqual({ kind: 'text', text: 'a' });
    expect(onInput.mock.calls[5][0]).toEqual({ kind: 'key', key: 'Escape' });
    expect(onPoint).not.toHaveBeenCalled();
  });

  // Pinned: on a Mac, any ⌘E leaves the mode, with Ctrl held or not, exactly as before Windows
  // and Linux were added; Ctrl+E alone is a key for the page. Off the Mac it's the other way round.
  it('leaves on ⌘E and on Ctrl+⌘E on a Mac, and sends Ctrl+E to the page', () => {
    const onInput = vi.fn();
    const r = render(<LiveView address="x" viewport={vp} source="sample" passThrough onInput={onInput} onPoint={() => undefined} />);
    const hit = r.container.querySelector('.live-hit')!;
    fireEvent.keyDown(hit, { key: 'e', metaKey: true });
    fireEvent.keyDown(hit, { key: 'e', metaKey: true, ctrlKey: true });
    fireEvent.keyDown(hit, { key: 'E', metaKey: true, shiftKey: true });
    expect(onInput).not.toHaveBeenCalled();
    fireEvent.keyDown(hit, { key: 'e', ctrlKey: true });
    expect(onInput.mock.calls).toEqual([[{ kind: 'key', key: 'Control+e' }]]);
  });

  it('leaves on Ctrl+E on Windows and Linux, and sends ⌘E to the page', () => {
    for (const os of ['windows', 'linux'] as const) {
      setOsForTests(os);
      const onInput = vi.fn();
      const r = render(<LiveView address="x" viewport={vp} source="sample" passThrough onInput={onInput} onPoint={() => undefined} />);
      const hit = r.container.querySelector('.live-hit')!;
      fireEvent.keyDown(hit, { key: 'e', ctrlKey: true });
      expect(onInput).not.toHaveBeenCalled();
      fireEvent.keyDown(hit, { key: 'e', metaKey: true });
      expect(onInput).toHaveBeenCalledOnce();
      r.unmount();
      setOsForTests(null);
    }
  });

  it('names keys the way the browser takes them', () => {
    const k = (key: string, m: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
      keyName({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...m });
    expect(k('a')).toBeNull();
    expect(k(' ')).toBeNull();
    expect(k('Tab', { shiftKey: true })).toBe('Shift+Tab');
    expect(k('a', { metaKey: true })).toBe('Meta+a');
    expect(k('Shift', { shiftKey: true })).toBe('');
  });

  it('records nothing while on; afterwards the page counts as set up by hand until a fresh Run', async () => {
    const hand = vi.spyOn(getEngine(), 'hand');
    const rec = vi.spyOn(getEngine(), 'recordPoint');
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn() }));
    act(() => { result.current.load([{ id: 'a', action: 'click', label: 'Click A', at: [1, 1] }]); });
    await act(async () => { await result.current.setHand(true); });
    expect(hand).toHaveBeenLastCalledWith(true);
    act(() => { result.current.pagePoint([5, 5], 1); result.current.setAction('waitFor'); });
    act(() => { result.current.send(); });
    expect(result.current.ai.state).toBe('idle');
    expect(rec).not.toHaveBeenCalled();
    await act(async () => { await result.current.setHand(false); });
    expect(hand).toHaveBeenLastCalledWith(false);
    expect(result.current.manual).toBe(true);
    expect(result.current.atStepId).toBeNull();
    act(() => { result.current.played({ full: false, at: 'a', insertAfter: null, step: 'a' }); });
    expect([...result.current.handPlayed]).toEqual(['a']);                // "Played on a page set up by hand"
    act(() => { result.current.played({ full: true, at: 'a', insertAfter: null, fresh: true }); });
    expect(result.current.manual).toBe(false);
    expect(result.current.handPlayed.size).toBe(0);
  });
});

describe('Write', () => {
  it('types the text exactly as written, spaces at either end included', () => {
    vi.spyOn(getEngine(), 'recordPoint');
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn() }));
    act(() => { result.current.load([]); result.current.setAction('write'); });
    act(() => { result.current.setText('  hello '); });
    act(() => { result.current.send(); });
    expect(result.current.steps.find(s => s.action === 'write')?.text).toBe('  hello ');
  });
});

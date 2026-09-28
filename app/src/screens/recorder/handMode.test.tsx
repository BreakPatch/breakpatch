// #35 Play this step plays up to the step before it by itself; #36 "Use the page".
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Step } from '../../data/types';
import { getEngine } from '../../engine';
import { LiveView } from '../../components/live/LiveView';
import { keyName } from '../../components/live/geometry';
import { StepsPanel } from '../../components/steps';
import { playUpToFirst } from './editorRun';
import { useRecorder } from './useRecorder';

Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const vp = { width: 800, height: 600 };

describe('Play this step, when the page is elsewhere', () => {
  const rows = ['a', 'b', 'c', 'd'];
  it('plays up to the step before it first, with no question', () => {
    expect(playUpToFirst(rows, 'd', 'a', false)).toBe('c');
    expect(playUpToFirst(rows, 'd', 'c', false)).toBeNull();             // already there
    expect(playUpToFirst(rows, 'a', null, false)).toBeNull();            // the first step
  });
  it('not after the page was used by hand, nor for "Play on the page as it is"', () => {
    expect(playUpToFirst(rows, 'd', null, true)).toBeNull();
    expect(playUpToFirst(rows, 'd', 'a', false, true)).toBeNull();
  });
  it('offers "Play on the page as it is" in the ⋯ menu', () => {
    const steps: Step[] = [{ id: 'a', action: 'click', label: 'Click A', at: [1, 1] }];
    const onPlayAsIs = vi.fn();
    const r = render(<StepsPanel steps={steps} mode="edit" selectedId="a" onPlayAsIs={onPlayAsIs} onPlayStep={() => undefined} onChange={() => undefined} onSelect={() => undefined} />);
    fireEvent.click(r.getByLabelText('More for this step'));
    fireEvent.click(r.getByRole('menuitem', { name: /Play on the page as it is/ }));
    expect(onPlayAsIs).toHaveBeenCalledWith('a');
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

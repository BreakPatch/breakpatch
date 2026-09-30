// The describe box decides the action from the sentence (intent.ts): what to do, what to do it to
// and how many times. The chosen action only counts when the sentence names none.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEngine } from '../../engine';
import { chosenIntent, fromEngine, readIntent, stepperTarget, type Intent } from './intent';
import { intentAskText } from './describe';
import { useRecorder } from './useRecorder';

afterEach(() => { vi.restoreAllMocks(); });

const intentOf = (s: string): Intent => {
  const r = readIntent(s);
  if (r.kind !== 'intent') throw new Error(`"${s}" read as ${r.kind}`);
  return r.intent;
};
const plus = (of: string) => ({ target: `the "+" button next to "${of}"`, near: { control: 'increase', of } });

describe('reading a described step', () => {
  it('"add 2 people" is two clicks on the + next to People', () => {
    expect(intentOf('add 2 people')).toMatchObject({ action: 'click', repeat: 2, ...plus('People'), from: 'words' });
    expect(intentOf('Add two more people.')).toMatchObject({ action: 'click', repeat: 2, ...plus('People') });
    expect(intentOf('add another adult')).toMatchObject({ action: 'click', repeat: 1, ...plus('Adult') });
    expect(intentOf('increase seats by 3')).toMatchObject({ action: 'click', repeat: 3, ...plus('Seats') });
    expect(intentOf('increase the number of rooms')).toMatchObject({ action: 'click', repeat: 1, ...plus('Rooms') });
  });

  it('"remove 1 person" and "decrease" are the −', () => {
    expect(intentOf('remove 1 person')).toMatchObject({ action: 'click', repeat: 1, target: 'the "−" button next to "Person"', near: { control: 'decrease', of: 'Person' } });
    expect(intentOf('decrease people by two')).toMatchObject({ repeat: 2, near: { control: 'decrease', of: 'People' } });
  });

  it('an "add" that is a button of its own stays a click on it', () => {
    expect(intentOf('add to cart')).toMatchObject({ action: 'click', target: 'add to cart', repeat: 1 });
    expect(intentOf('add a project')).toMatchObject({ action: 'click', target: 'add a project' });
    expect(intentOf('log out')).toMatchObject({ action: 'click', target: 'log out' });
    expect(readIntent('increase people to 3').kind).not.toBe('intent');        // depends on what's there now
  });

  it('"type hello into the search box" types into that field', () => {
    expect(intentOf('type hello into the search box')).toMatchObject({ action: 'write', text: 'hello', target: 'the search box', repeat: 1 });
    expect(intentOf('enter "New York" in the Destination field')).toMatchObject({ action: 'write', text: 'New York', target: 'the Destination field' });
    expect(intentOf('fill in the email field with ana@example.com')).toMatchObject({ action: 'write', text: 'ana@example.com', target: 'the email field' });
    expect(intentOf('search for running shoes')).toMatchObject({ action: 'write', text: 'running shoes', target: 'the search box' });
    expect(intentOf('type hello')).toMatchObject({ action: 'write', text: 'hello', target: undefined });   // the field with the focus
    // With Click chosen too: "write 3" types 3, it doesn't look for a "3" to click.
    for (const s of ['write 3', 'enter 3', 'put 3', 'fill in 3', 'type 3']) expect(intentOf(s)).toMatchObject({ action: 'write', text: '3', target: undefined });
    expect(intentOf('write hello into the Name field')).toMatchObject({ action: 'write', text: 'hello', target: 'the Name field' });
    expect(intentOf('put 3 in the quantity box')).toMatchObject({ action: 'write', text: '3', target: 'the quantity box' });
    expect(intentOf('fill in the quantity with 3')).toMatchObject({ action: 'write', text: '3', target: 'the quantity' });
    expect(readIntent('fill in the form').kind).not.toBe('intent');
  });

  it('"scroll down" scrolls the page', () => {
    expect(intentOf('scroll down')).toMatchObject({ action: 'scroll', direction: 'down', distance: 300, target: undefined, repeat: 1 });
    expect(intentOf('scroll up 500 px')).toMatchObject({ action: 'scroll', direction: 'up', distance: 500 });
    expect(intentOf('scroll')).toMatchObject({ action: 'scroll', direction: 'down' });
    expect(intentOf('scroll to the bottom')).toMatchObject({ action: 'scroll', direction: 'down', distance: 5000 });
    expect(intentOf('scroll to the top')).toMatchObject({ action: 'scroll', direction: 'up' });
    expect(intentOf('scroll down a little')).toMatchObject({ direction: 'down', distance: 150 });
    expect(intentOf('scroll down in the results list')).toMatchObject({ direction: 'down', target: 'the results list' });
    expect(intentOf('scroll down 3 times')).toMatchObject({ action: 'scroll', repeat: 3 });
  });

  it('"click the Sign up button" is a click, whatever action is chosen', () => {
    const it = intentOf('click the Sign up button');
    expect(it).toMatchObject({ action: 'click', target: 'the Sign up button', repeat: 1, from: 'words' });
    expect(intentOf('Please press the Done button.')).toMatchObject({ action: 'click', target: 'the Done button' });
    expect(intentOf('tap on Next')).toMatchObject({ action: 'click', target: 'Next' });
  });

  it('reads the other actions, counts and number words', () => {
    expect(intentOf('double click the first row')).toMatchObject({ action: 'doubleClick', target: 'the first row' });
    expect(intentOf('right-click the file')).toMatchObject({ action: 'rightClick', target: 'the file' });
    expect(intentOf('long press the photo')).toMatchObject({ action: 'longClick', target: 'the photo' });
    expect(intentOf('hover over the Account menu')).toMatchObject({ action: 'hover', target: 'the Account menu' });
    expect(intentOf('wait 3 seconds')).toMatchObject({ action: 'waitFor', seconds: 3 });
    expect(intentOf('wait for two seconds')).toMatchObject({ action: 'waitFor', seconds: 2 });
    expect(intentOf('wait until the success message appears')).toMatchObject({ action: 'waitUntil', target: 'the success message' });
    expect(intentOf('check that the success message is visible')).toMatchObject({ action: 'checkpoint', target: 'the success message' });
    expect(intentOf('verify the total shows')).toMatchObject({ action: 'checkpoint', target: 'the total' });
    expect(intentOf('click Next 3 times')).toMatchObject({ action: 'click', target: 'Next', repeat: 3 });
    expect(intentOf('click the + twice')).toMatchObject({ action: 'click', target: 'the +', repeat: 2 });
    expect(intentOf('click Next fifty times')).toMatchObject({ target: 'Next fifty times', repeat: 1 });     // not a number it knows
    expect(intentOf('click Next 99 times')).toMatchObject({ repeat: 20 });                                   // at most 20 steps
    expect(intentOf('go to example.com/pricing')).toMatchObject({ action: 'navigate', url: 'https://example.com/pricing' });
    expect(intentOf('go to the pricing page')).toMatchObject({ action: 'click', target: 'the pricing page' });
  });

  it('a sentence that names no action leaves it to the chosen one', () => {
    expect(readIntent('the Done button')).toEqual({ kind: 'noVerb', target: 'the Done button' });
    expect(readIntent('Sign up button')).toEqual({ kind: 'noVerb', target: 'Sign up button' });
    expect(chosenIntent('the Done button', 'scroll', { direction: 'up', distance: 400 })).toMatchObject({ action: 'scroll', target: 'the Done button', direction: 'up', distance: 400, from: 'chosen' });
    expect(chosenIntent('the Done button', 'write', { direction: 'down', distance: 300 })).toMatchObject({ action: 'click' });
    // Words it can't place go to the AI assistant first.
    expect(readIntent('empty the basket')).toEqual({ kind: 'unsure', target: 'empty the basket' });
  });

  it('takes the AI assistant\'s reading only when it adds up', () => {
    expect(fromEngine({ action: 'click', repeat: 2, target: 'the Empty basket button' })).toMatchObject({ action: 'click', repeat: 2, target: 'the Empty basket button', from: 'ai' });
    expect(fromEngine({ action: 'scroll', repeat: 1, direction: 'up' })).toMatchObject({ action: 'scroll', direction: 'up', distance: 300 });
    expect(fromEngine({ action: 'click', repeat: 1 })).toBeNull();
    expect(fromEngine({ action: 'dance', repeat: 1, target: 'x' })).toBeNull();
    expect(fromEngine(null)).toBeNull();
  });

  it('asks plainly what Confirm will do', () => {
    expect(intentAskText('the Done button', { action: 'click', repeat: 1 })).toBe('Is this the Done button?');
    expect(intentAskText(stepperTarget('increase', 'people').target, { action: 'click', repeat: 2 }))
      .toBe('Is this the "+" button next to "People"? Confirm to click it 2 times.');
    expect(intentAskText('the search box', { action: 'write', repeat: 1, text: 'hello' })).toBe('Is this the search box? Confirm to type "hello" into it.');
  });
});

describe('the recorder does what the sentence says', () => {
  const vp = { width: 1440, height: 900 };
  const hook = () => renderHook(() => useRecorder({ viewport: vp, onError: vi.fn() }));

  it('"add 2 people" finds the + next to People and, after one Confirm, adds two clicks on it', async () => {
    const locate = vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [256, 153, 292, 189], at: [274, 171], target: 'the "+" button next to "People"', frame: 4 });
    const intent = vi.spyOn(getEngine(), 'intent');
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: `s${rec.mock.calls.length}`, action: p.action, label: 'Click +', at: p.at, target: p.target }));
    const { result } = hook();
    act(() => { result.current.setAction('scroll'); });            // the chosen action doesn't decide
    await act(async () => { await result.current.describe('add 2 people'); });
    expect(locate).toHaveBeenCalledWith('the "+" button next to "People"', { near: { control: 'increase', of: 'People' } });
    expect(intent).not.toHaveBeenCalled();                          // the words were enough
    expect(result.current.ai.state).toBe('result');
    expect(result.current.ask).toBe('Is this the "+" button next to "People"? Confirm to click it 2 times.');
    expect(rec).not.toHaveBeenCalled();                             // nothing reaches the page before Confirm
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.steps).toHaveLength(2));
    expect(rec.mock.calls.map(c => c[0])).toEqual([
      { action: 'click', at: [274, 171], target: 'the "+" button next to "People"', frame: 4 },
      { action: 'click', at: [274, 171], target: 'the "+" button next to "People"' },           // the page moved on: no frame
    ]);
    expect(result.current.steps.map(s => s.action)).toEqual(['click', 'click']);
    expect(result.current.action).toBe('scroll');                   // still chosen for page clicks
  });

  it('stops repeating at the first step that fails', async () => {
    vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [0, 0, 10, 10], at: [5, 5], target: 'Next' });
    const onError = vi.fn();
    const rec = vi.spyOn(getEngine(), 'recordPoint')
      .mockResolvedValueOnce({ id: 'a', action: 'click', label: 'Click Next', at: [5, 5] })
      .mockRejectedValueOnce(new Error('The page changed.'));
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError }));
    await act(async () => { await result.current.describe('click Next 3 times'); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(onError).toHaveBeenCalledWith('The page changed.'));
    expect(rec).toHaveBeenCalledTimes(2);
    expect(result.current.steps.map(s => s.id)).toEqual(['a']);
  });

  it('"click the Sign up button" with Scroll chosen clicks it', async () => {
    vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [0, 0, 10, 10], at: [5, 5], target: 'the Sign up button' });
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'x', action: p.action, label: 'Click Sign up', at: p.at }));
    const { result } = hook();
    act(() => { result.current.setAction('scroll'); });
    await act(async () => { await result.current.describe('click the Sign up button'); });
    expect(result.current.ask).toBe('Is this the Sign up button?');
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(rec).toHaveBeenCalled());
    expect(rec.mock.calls[0][0]).toMatchObject({ action: 'click', at: [5, 5] });
  });

  it('"scroll down" is shown for Confirm without looking for anything', async () => {
    const locate = vi.spyOn(getEngine(), 'locate');
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'x', action: p.action, label: 'Scroll down', from: p.from }));
    const { result } = hook();
    await act(async () => { await result.current.describe('scroll down'); });
    expect(locate).not.toHaveBeenCalled();
    expect(result.current.ai.state).toBe('proposal');
    expect(result.current.ask).toBe('Scroll down 300 px?');
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(rec).toHaveBeenCalled());
    expect(rec.mock.calls[0][0]).toMatchObject({ action: 'scroll', from: [720, 450], direction: 'down', distance: 300 });
  });

  it('"write 3" with Click chosen types 3 into the field that has the focus, looking for nothing', async () => {
    const locate = vi.spyOn(getEngine(), 'locate');
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'w', action: p.action, label: 'Write "3"', text: p.text }));
    const { result } = hook();
    expect(result.current.action).toBe('click');
    await act(async () => { await result.current.describe('write 3'); });
    expect(locate).not.toHaveBeenCalled();
    await waitFor(() => expect(rec).toHaveBeenCalled());
    expect(rec.mock.calls[0][0]).toEqual({ action: 'write', text: '3' });
  });

  it('"type hello into the search box" types there once it\'s confirmed', async () => {
    vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [0, 0, 100, 30], at: [50, 15], target: 'the search box' });
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'w', action: p.action, label: 'Write "hello"', at: p.at, text: p.text }));
    const { result } = hook();
    await act(async () => { await result.current.describe('type hello into the search box'); });
    expect(result.current.ask).toBe('Is this the search box? Confirm to type "hello" into it.');
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(rec).toHaveBeenCalled());
    expect(rec.mock.calls[0][0]).toMatchObject({ action: 'write', at: [50, 15], text: 'hello', target: 'the search box' });
  });

  it('asks the AI assistant only for words it can\'t place, and uses the chosen action without it', async () => {
    const intent = vi.spyOn(getEngine(), 'intent').mockResolvedValue(null);
    const locate = vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [0, 0, 10, 10], at: [5, 5], target: 'empty the basket' });
    const { result } = hook();
    act(() => { result.current.setAction('hover'); });
    await act(async () => { await result.current.describe('empty the basket'); });
    expect(intent).toHaveBeenCalledWith('empty the basket');
    expect(locate).toHaveBeenCalledWith('empty the basket', undefined);
    expect(result.current.ai).toMatchObject({ state: 'result', intent: { action: 'hover', from: 'chosen' } });
    // The AI assistant's reading wins when it has one.
    intent.mockResolvedValue({ action: 'click', repeat: 1, target: 'the Empty basket button' });
    await act(async () => { await result.current.describe('empty the basket'); });
    expect(locate).toHaveBeenLastCalledWith('the Empty basket button', undefined);
    expect(result.current.ai).toMatchObject({ state: 'result', intent: { action: 'click', from: 'ai' } });
    // A noun phrase needs no AI assistant: the chosen action applies at once.
    intent.mockClear();
    await act(async () => { await result.current.describe('the Done button'); });
    expect(intent).not.toHaveBeenCalled();
  });
});

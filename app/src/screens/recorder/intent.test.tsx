// The describe box decides the action from the sentence (intent.ts): what to do, what to do it to
// and how many times. The chosen action only counts when the sentence names none.
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEngine } from '../../engine';
import { AI_ACTIONS, chosenIntent, fromEngine, MAX_REPEAT, readIntent, stepperTarget, type Intent } from './intent';
import { intentAskText } from './describe';
import { useRecorder } from './useRecorder';

afterEach(() => { vi.restoreAllMocks(); });

// The engine lives outside the app root, which Vite won't import from, so read it from disk
// (as paths.test.ts does; Node modules are untyped in the app's tsconfig).
const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };

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
    // "type hello 3 times": the count isn't dropped.
    expect(intentOf('type hello 3 times')).toMatchObject({ action: 'write', text: 'hello', repeat: 3 });
    expect(intentOf('type hello into the search box twice')).toMatchObject({ action: 'write', text: 'hello', target: 'the search box', repeat: 2 });
  });

  it('reads everyday sentences the way they are meant (regressions)', () => {
    // A wait for something to go away isn't a Wait until (that waits for it to show).
    for (const s of ['wait for the spinner to go away', 'wait until the spinner disappears', 'wait for the dialog to close', 'wait until the banner is gone', 'wait until the loader is no longer visible'])
      expect(readIntent(s).kind, s).toBe('unhandled');
    expect(intentOf('wait until the dialog shows')).toMatchObject({ action: 'waitUntil', target: 'the dialog' });
    // A button's word, then what it acts on: a click, not a noun phrase for the chosen action.
    expect(intentOf('Add a new item')).toMatchObject({ action: 'click', target: 'Add a new item' });
    expect(intentOf('delete this row')).toMatchObject({ action: 'click', target: 'delete this row' });
    expect(readIntent('Save button')).toEqual({ kind: 'noVerb', target: 'Save button' });
    // A thing put somewhere isn't the "+" next to it.
    expect(readIntent('add 2 items to the cart')).toEqual({ kind: 'unsure', target: 'add 2 items to the cart' });
    expect(readIntent('remove 1 item from the basket').kind).toBe('unsure');
    // A number to choose depends on what's there now: not a click on something named "2 adults".
    expect(readIntent('select 2 adults')).toEqual({ kind: 'unsure', target: 'select 2 adults' });
    expect(intentOf('select the second option')).toMatchObject({ action: 'click', target: 'the second option' });
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
    for (const action of AI_ACTIONS) expect(fromEngine({ action, repeat: 1, target: 'x', text: 'y', seconds: 1 })?.action).toBe(action);
  });

  it('keeps the most steps one sentence can add the same as the engine\'s', () => {
    // The engine's own reading (record.intent) clamps `times` to its MAX_REPEAT: both must agree.
    const py = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../../engine/src/breakpatch_engine/locator.py'), 'utf8');
    expect(Number(/^MAX_REPEAT = (\d+)$/m.exec(py)?.[1])).toBe(MAX_REPEAT);
  });

  it('asks plainly what Confirm will do', () => {
    expect(intentAskText('the Done button', { action: 'click', repeat: 1 })).toBe('Is this the Done button?');
    expect(intentAskText(stepperTarget('increase', 'people').target, { action: 'click', repeat: 2 }))
      .toBe('Is this the "+" button next to "People"? Confirm to click it 2 times.');
    expect(intentAskText('the search box', { action: 'write', repeat: 1, text: 'hello' })).toBe('Is this the search box? Confirm to type "hello" into it.');
    expect(intentAskText('the search box', { action: 'write', repeat: 2, text: 'hello' })).toBe('Is this the search box? Confirm to type "hello" into it 2 times.');
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

  it('"write 3" with Click chosen types 3 into the field that has the focus once it\'s confirmed, looking for nothing', async () => {
    const locate = vi.spyOn(getEngine(), 'locate');
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'w', action: p.action, label: 'Write "3"', text: p.text }));
    const { result } = hook();
    expect(result.current.action).toBe('click');
    await act(async () => { await result.current.describe('write 3'); });
    expect(locate).not.toHaveBeenCalled();
    expect(result.current.ai.state).toBe('proposal');
    expect(result.current.ask).toBe('Write "3" into the field that has the focus?');
    expect(rec).not.toHaveBeenCalled();                              // nothing reaches the page before Confirm
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(rec).toHaveBeenCalled());
    expect(rec.mock.calls[0][0]).toEqual({ action: 'write', text: '3' });
  });

  it('a misread "enter the password" is only typed after Confirm, and Cancel types nothing', async () => {
    const rec = vi.spyOn(getEngine(), 'recordPoint');
    const { result } = hook();
    await act(async () => { await result.current.describe('enter the password'); });
    expect(result.current.ask).toBe('Write "the password" into the field that has the focus?');
    act(() => { result.current.cancelAi(); });
    expect(result.current.ai.state).toBe('idle');
    expect(rec).not.toHaveBeenCalled();
    expect(result.current.steps).toEqual([]);
  });

  it('"go to example.com" asks before it opens the address', async () => {
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 'n', action: p.action, label: 'Go to https://example.com', nav: p.nav, url: p.url }));
    const { result } = hook();
    await act(async () => { await result.current.describe('go to example.com'); });
    expect(result.current.ai).toMatchObject({ state: 'proposal', params: { action: 'navigate', nav: 'url', url: 'https://example.com' } });
    expect(result.current.ai.state === 'proposal' && result.current.ai.box).toBeUndefined();   // nothing to mark on the page
    expect(result.current.ask).toBe('Go to https://example.com?');
    expect(rec).not.toHaveBeenCalled();
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(rec).toHaveBeenCalledTimes(1));
    expect(rec.mock.calls[0][0]).toEqual({ action: 'navigate', nav: 'url', url: 'https://example.com' });
  });

  it('"type hello 3 times" asks once and types it 3 times', async () => {
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: `w${rec.mock.calls.length}`, action: p.action, label: 'Write "hello"', text: p.text }));
    const { result } = hook();
    await act(async () => { await result.current.describe('type hello 3 times'); });
    expect(result.current.ask).toBe('Write "hello" into the field that has the focus, 3 times?');
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.steps).toHaveLength(3));
    expect(rec).toHaveBeenCalledTimes(3);
  });

  it('"wait for the spinner to go away" says it can\'t, and waits for nothing', async () => {
    const onError = vi.fn();
    const locate = vi.spyOn(getEngine(), 'locate');
    const rec = vi.spyOn(getEngine(), 'recordPoint');
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError }));
    await act(async () => { await result.current.describe('wait for the spinner to go away'); });
    expect(onError).toHaveBeenCalledWith(expect.stringMatching(/can't wait for something to go away/));
    expect(locate).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
    expect(result.current.text).toBe('wait for the spinner to go away');   // kept, to rephrase
  });

  it('a repeat while re-recording re-records the step once and adds the rest right after it', async () => {
    vi.spyOn(getEngine(), 'locate').mockResolvedValue({ box: [0, 0, 10, 10], at: [5, 5], target: 'Next' });
    const rec = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: `n${rec.mock.calls.length}`, action: p.action, label: 'Click Next', at: p.at }));
    const { result } = hook();
    act(() => { result.current.load([
      { id: 'a', action: 'click', label: 'Click A', at: [1, 1] },
      { id: 'b', action: 'click', label: 'Click B', at: [2, 2] },
      { id: 'c', action: 'click', label: 'Click C', at: [3, 3] },
    ]); });
    act(() => { result.current.startRerecord('b'); });
    await act(async () => { await result.current.describe('click Next 3 times'); });
    act(() => { result.current.confirmAi(); });
    await waitFor(() => expect(result.current.steps).toHaveLength(5));
    expect(rec).toHaveBeenCalledTimes(3);
    // Step b keeps its place and id; the two other clicks come right after it, before c.
    expect(result.current.steps.map(s => s.id)).toEqual(['a', 'b', 'n2', 'n3', 'c']);
    expect(result.current.steps.map(s => s.label)).toEqual(['Click A', 'Click Next', 'Click Next', 'Click Next', 'Click C']);
    expect(result.current.rerecordId).toBeNull();
    expect(result.current.insertAfterId).toBeNull();               // new steps go at the end again
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

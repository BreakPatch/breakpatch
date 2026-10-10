// A Call step (issue #44): the call rules the form checks, the dialog that adds and edits one, the
// recorder making the call when it's added, a Write step typing a value one keeps, the run's notes
// and the secrets a run reads. The tests folder's format: data/local/callFormat.test.ts.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { HttpCall, Step } from '../../data/types';
import { EngineError, getEngine, type CallReply, type Engine } from '../../engine';
import { callLabel } from '../../engine/labels';
import {
  callStepProblem, cleanCall, describeReply, keepProblem, keptNames, pathProblem, statusProblem, tryCall,
} from '../../lib/calls';
import { passNote, reasonText, reasonTitle } from '../../lib/runWords';
import { useSession } from '../../state/session';
import { DEMO_WORKSPACE } from '../../data/demo/demoBackend';
import { defaultLabel, stepIcon, stepNote } from '../steps/stepText';
import { StepsPanel } from '../steps';
import { CallStepDialog } from './CallStepDialog';
import { CallFields } from './CallFields';
import { useRecorder } from '../../screens/recorder/useRecorder';
import { secretNames } from '../../screens/run/resolve';
import { INITIAL_RUN, runReducer } from '../../screens/run/runState';

Element.prototype.scrollIntoView ??= () => undefined;   // not in jsdom
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
beforeEach(() => { useSession.setState({ workspace: DEMO_WORKSPACE, local: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const APP = 'https://app.acme.com';
const call = (over: Partial<Step> = {}): Step => ({
  id: 'c1', action: 'call', label: 'Call POST api.acme.com/test/orders/paid',
  call: { method: 'POST', url: 'https://api.acme.com/test/orders/paid', body: '{"paid": true}', headers: [{ name: 'Authorization', secretRef: 'API_TOKEN' }] }, ...over,
});

describe('the rules a Call step is checked against before it is saved', () => {
  it('statuses that pass: codes, classes and ranges, never a redirect', () => {
    for (const ok of [undefined, '', '2xx', '200, 201', '200 404', '2xx,4XX', '200-204']) expect(statusProblem(ok)).toBeUndefined();
    expect(statusProblem('abc')).toMatch(/look like 200, 2xx or 200-204/);
    expect(statusProblem('199')).toMatch(/between 200 and 599/);
    expect(statusProblem('204-200')).toMatch(/between 200 and 599/);
    for (const r of ['302', '3xx', '200-399']) expect(statusProblem(r)).toMatch(/redirect/);
  });

  it('where a kept value is, and its name', () => {
    for (const ok of ['$.code', 'code', '$.data.items[0].id', "$['one-time code']"]) expect(pathProblem(ok)).toBeUndefined();
    for (const bad of ['', '$', '$..x', '$.a b', '$.a[x]']) expect(pathProblem(bad)).toBeDefined();
    expect(keepProblem({ path: '$.code', name: 'CODE' })).toBeUndefined();
    expect(keepProblem({ path: '$.code', name: '1CODE' })).toMatch(/letters, numbers and _/);
    expect(keepProblem({ path: '$.code', name: 'CODE' }, ['CODE'])).toBe('Another Call step keeps a value with that name.');
  });

  it("the call: the set-up call's rules, a body only off GET, and the step's own options", () => {
    expect(callStepProblem(call(), APP)).toBeUndefined();
    expect(callStepProblem(call({ call: { method: 'POST', url: '' } }), APP)).toBe('Enter the address to call.');
    expect(callStepProblem(call({ call: { method: 'POST', url: 'https://evil.example/x' } }), APP)).toMatch(/Allow other hosts/);
    expect(callStepProblem(call({ call: { method: 'POST', url: 'https://evil.example/x', allowOtherHosts: true } }), APP)).toBeUndefined();
    expect(callStepProblem(call({ call: { method: 'POST', url: 'http://api.acme.com/x' } }), APP)).toMatch(/https:\/\//);
    expect(callStepProblem(call({ call: { method: 'GET', url: 'https://api.acme.com/x', body: 'x' } }), APP)).toMatch(/GET call can't have a body/);
    expect(callStepProblem(call({ call: { method: 'POST', url: 'https://api.acme.com/x', body: 'x'.repeat(65 * 1024) } }), APP)).toMatch(/too long/);
    expect(callStepProblem(call({ passStatus: '3xx' }), APP)).toMatch(/redirect/);
    expect(callStepProblem(call({ keep: { path: '$.', name: 'CODE' } }), APP)).toMatch(/Write where the value is/);
  });

  it('saves a body as typed, and none on a GET', () => {
    expect(cleanCall({ method: 'POST', url: ' https://a.acme.com/x ', body: ' {"a": 1} ' }, false)).toEqual({ method: 'POST', url: 'https://a.acme.com/x', body: ' {"a": 1} ' });
    expect(cleanCall({ method: 'GET', url: 'https://a.acme.com/x', body: 'x' }, false)).toEqual({ method: 'GET', url: 'https://a.acme.com/x' });
    expect(cleanCall({ method: 'POST', url: 'https://a.acme.com/x', body: '  ' }, true)).toEqual({ method: 'POST', url: 'https://a.acme.com/x', allowOtherHosts: true });
  });

  it("Try it sends the step's options to the engine and never gets the kept value back", async () => {
    const seen: unknown[][] = [];
    const engine = { tryCall: async (...a: unknown[]) => { seen.push(a); return { ok: true, status: 200, ms: 300, kept: true } satisfies CallReply; } } as unknown as Engine;
    const r = await tryCall({ method: 'POST', url: 'https://api.acme.com/code' }, { engine, appUrl: APP, step: { passStatus: '200', keep: { path: '$.code', name: 'CODE' }, timeoutMs: 5000 } });
    expect(r).toEqual({ ok: true, status: 200, ms: 300, kept: true });
    expect(describeReply(r)).toBe('Replied 200 in 0.3 s, and the value is there');
    expect(seen[0][4]).toEqual({ passStatus: '200', keep: { path: '$.code', name: 'CODE' }, timeoutMs: 5000 });
    expect(describeReply({ ok: false, error: 'timeout' }, 30)).toBe('No reply after 30 s');
    expect(describeReply({ ok: false, status: 200, ms: 10, error: 'keep', message: 'The reply has nothing at $.code.' })).toBe('The reply has nothing at $.code.');
  });
});

describe('Try it', () => {
  function Fields() {
    const [c, setC] = useState<HttpCall>({ method: 'POST', url: 'https://api.acme.com/a' });
    return <CallFields title="Call" call={c} onChange={setC} appUrl={APP} otherHosts={false} secretNames={[]} />;
  }

  it("shows the latest call's reply only, never one to the call before an edit", async () => {
    const pending: ((r: CallReply) => void)[] = [];
    vi.spyOn(getEngine(), 'tryCall').mockImplementation(() => new Promise<CallReply>(r => { pending.push(r); }));
    render(<Fields />);
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    await waitFor(() => expect(pending).toHaveLength(1));
    expect(screen.getByText('Calling…')).toBeInTheDocument();
    // Edited while the first call waits: Try it is free again, for the new address.
    fireEvent.change(screen.getByLabelText('Call: address'), { target: { value: 'https://api.acme.com/b' } });
    expect(screen.queryByText('Calling…')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[0]({ ok: false, status: 500, ms: 10 }); });
    expect(screen.queryByText(/500/)).toBeNull();
    expect(screen.getByText('Calling…')).toBeInTheDocument();
    await act(async () => { pending[1]({ ok: true, status: 200, ms: 300 }); });
    expect(screen.getByText('Replied 200 in 0.3 s')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try it' })).toBeEnabled();
  });
});

describe('a Call step in the step list', () => {
  it('is named by its method and where, never its query string, with the API icon', () => {
    expect(callLabel({ method: 'POST', url: 'https://api.acme.com/test/orders/42/pay?token=abc' })).toBe('Call POST api.acme.com/test/orders/42/pay');
    expect(callLabel({ method: 'GET', url: 'https://api.acme.com/' })).toBe('Call GET api.acme.com');
    expect(callLabel(undefined)).toBe('Call your API');
    expect(defaultLabel({ action: 'call', call: { method: 'DELETE', url: 'https://api.acme.com/t/1' } })).toBe('Call DELETE api.acme.com/t/1');
    expect(stepIcon(call())).toBe('api');
    expect(stepNote(call({ keep: { path: '$.code', name: 'CODE' } }))).toBe('Keeps $.code as CODE');
    expect(defaultLabel({ action: 'write', valueRef: 'CODE' })).toBe('Write the value CODE');
    expect(stepIcon({ action: 'write', valueRef: 'CODE' })).toBe('data_object');
    expect(keptNames([call({ keep: { path: '$.a', name: 'A' } }), { id: 'l', action: 'loop', label: 'Repeat', steps: [call({ id: 'c2', keep: { path: '$.b', name: 'B' } })] }])).toEqual(['A', 'B']);
  });

  it("opens its own editor from Edit, saves the change and isn't re-recorded", async () => {
    const onChange = vi.fn(), onEdited = vi.fn();
    render(<StepsPanel steps={[call()]} mode="edit" selectedId="c1" onChange={onChange} onEdited={onEdited} onRerecord={vi.fn()} appUrl={APP} />);
    fireEvent.click(screen.getByRole('button', { name: 'More for this step' }));
    expect(screen.queryByRole('menuitem', { name: /Re-record/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit the call' });
    expect(within(dialog).getByLabelText('Call: address')).toHaveValue('https://api.acme.com/test/orders/paid');
    expect(within(dialog).getByLabelText('Call: body')).toHaveValue('{"paid": true}');
    fireEvent.change(within(dialog).getByLabelText('Call: address'), { target: { value: 'https://api.acme.com/test/orders/refund' } });
    fireEvent.change(within(dialog).getByLabelText('Replies that pass'), { target: { value: '200, 409' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = (onChange.mock.calls[0][0] as Step[])[0];
    expect(saved).toMatchObject({ id: 'c1', action: 'call', label: 'Call POST api.acme.com/test/orders/refund', passStatus: '200, 409',
      call: { method: 'POST', url: 'https://api.acme.com/test/orders/refund', body: '{"paid": true}', headers: [{ name: 'Authorization', secretRef: 'API_TOKEN' }] } });
    expect(saved.timeoutMs).toBeUndefined();
    expect(onEdited).toHaveBeenCalledWith('c1', true);
  });
});

describe('the Call step dialog', () => {
  it("says what's wrong only after Add step, and stays open when the call didn't work", async () => {
    let answer = false;
    const onSave = vi.fn(async () => answer), onClose = vi.fn();
    render(<CallStepDialog open adding appUrl={APP} takenNames={['CODE']} onSave={onSave} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Call your API' });
    expect(within(dialog).queryByText('Enter the address to call.')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(await within(dialog).findByText('Enter the address to call.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText('Call: address'), { target: { value: 'https://api.acme.com/test/code' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Keep a value from the reply' }));
    fireEvent.change(within(dialog).getByLabelText('Where the value is in the reply'), { target: { value: '$.code' } });
    fireEvent.change(within(dialog).getByLabelText('Name of the value'), { target: { value: 'CODE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add step' }));
    expect(await within(dialog).findByText('Another Call step keeps a value with that name.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Name of the value'), { target: { value: 'OTP' } });
    fireEvent.change(within(dialog).getByLabelText('Wait, seconds'), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]).toEqual([{ call: { method: 'POST', url: 'https://api.acme.com/test/code' }, passStatus: undefined, timeoutMs: 10000,
      keep: { path: '$.code', name: 'OTP' }, label: 'Call POST api.acme.com/test/code' }]);
    expect(onClose).not.toHaveBeenCalled();
    answer = true;
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Try it makes the call with the step's options, a body and the header's saved secret", async () => {
    const spy = vi.spyOn(getEngine(), 'tryCall').mockResolvedValue({ ok: false, status: 500, ms: 120, error: 'status', message: 'It replied 500.' });
    render(<CallStepDialog open step={call({ passStatus: '201' })} appUrl={APP} onSave={vi.fn()} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'Edit the call' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Try it' }));
    expect(await within(dialog).findByText('Replied 500 in 0.1 s')).toBeInTheDocument();
    const [sent, appUrl, , scope, step] = spy.mock.calls[0];
    expect(sent).toEqual({ method: 'POST', url: 'https://api.acme.com/test/orders/paid', body: '{"paid": true}', headers: [{ name: 'Authorization', secretRef: 'API_TOKEN' }] });
    expect(appUrl).toBe(APP);
    expect(scope).toEqual({ workspace: 'demo' });
    expect(step).toEqual({ passStatus: '201', timeoutMs: 30000 });
  });
});

describe('adding a Call step in the recorder', () => {
  const vp = { width: 1440, height: 900 };

  it('makes the call with the app address and its header secrets, and adds the step the engine returns', async () => {
    const spy = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 's9', action: 'call', label: 'Call POST api.acme.com/x', call: p.call, keep: p.keep }));
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError: vi.fn(), appUrl: APP }));
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.recordCall({ call: { method: 'POST', url: 'https://api.acme.com/x', headers: [{ name: 'Authorization', secretRef: 'ACME_TEST_PASSWORD' }] }, keep: { path: '$.code', name: 'CODE' }, label: 'Call POST api.acme.com/x' }); });
    expect(ok).toBe(true);
    expect(spy.mock.calls[0][0]).toEqual({ action: 'call', call: { method: 'POST', url: 'https://api.acme.com/x', headers: [{ name: 'Authorization', secretRef: 'ACME_TEST_PASSWORD' }] },
      keep: { path: '$.code', name: 'CODE' }, appUrl: APP, label: 'Call POST api.acme.com/x', secrets: { ACME_TEST_PASSWORD: 'demo-password' }, workspace: 'demo' });
    expect(result.current.steps.map(s => s.action)).toEqual(['call']);
    expect(JSON.stringify(result.current.steps)).not.toContain('demo-password');
  });

  it("isn't added when the call doesn't work, and says why", async () => {
    vi.spyOn(getEngine(), 'recordPoint').mockRejectedValue(new EngineError('network', "The call didn't work. It replied 500."));
    const onError = vi.fn();
    const { result } = renderHook(() => useRecorder({ viewport: vp, onError, appUrl: APP }));
    let ok: boolean | undefined;
    await act(async () => { ok = await result.current.recordCall({ call: { method: 'POST', url: 'https://api.acme.com/x' }, label: 'Call POST api.acme.com/x' }); });
    expect(ok).toBe(false);
    expect(result.current.steps).toEqual([]);
    expect(onError).toHaveBeenCalledWith("The call didn't work. It replied 500.");
  });

  it('is in the action list, and a Write step after it can type the value it keeps', async () => {
    const { AddStepBar } = await import('../../screens/recorder/AddStepBar');
    const spy = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => (p.action === 'call'
      ? { id: 's1', action: 'call', label: 'Call POST api.acme.com/code', call: p.call, keep: p.keep }
      : { id: 's2', action: 'write', label: 'Write the value CODE', valueRef: p.valueRef }));
    function Bar() {
      const r = useRecorder({ viewport: vp, onError: vi.fn(), appUrl: APP });
      return <AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} describe={false} />;
    }
    render(<Bar />);
    fireEvent.click(screen.getByRole('button', { name: /Click/, expanded: false }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Call your API/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Call your API' });
    expect(within(dialog).getByText(/Add step calls it now/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Call: address'), { target: { value: 'https://api.acme.com/code' } });
    fireEvent.click(within(dialog).getByRole('switch', { name: 'Keep a value from the reply' }));
    fireEvent.change(within(dialog).getByLabelText('Where the value is in the reply'), { target: { value: '$.code' } });
    fireEvent.change(within(dialog).getByLabelText('Name of the value'), { target: { value: 'CODE' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Call your API' })).toBeNull());
    expect(spy.mock.calls[0][0]).toMatchObject({ action: 'call', appUrl: APP, keep: { path: '$.code', name: 'CODE' } });
    // Write: "From a call" is offered now that a Call step keeps a value.
    fireEvent.click(screen.getByRole('button', { name: /Click/, expanded: false }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Write text/ }));
    fireEvent.click(await screen.findByRole('radio', { name: 'From a call' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toMatchObject({ action: 'write', valueRef: 'CODE', appUrl: APP });
  });
});

describe('a run with Call steps', () => {
  it("reads the saved secrets a Call step's headers use", () => {
    expect(secretNames([call(), { id: 'w', action: 'write', label: 'Write', secretRef: 'PW' }, { id: 'l', action: 'loop', label: 'Repeat', steps: [call({ id: 'c2', call: { method: 'GET', url: 'https://a', headers: [{ name: 'X', secretRef: 'OTHER' }, { name: 'Y', value: 'v' }] } })] }]))
      .toEqual(['API_TOKEN', 'PW', 'OTHER']);
  });

  it('notes what a Call step replied and how long it took, and why one failed', () => {
    let s = runReducer(INITIAL_RUN, { type: 'start', runId: 'r', ids: ['c1'], at: 0 });
    s = runReducer(s, { type: 'step', ev: { runId: 'r', index: 0, stepId: 'c1', state: 'passed', reply: { status: 201, ms: 412 } } });
    expect(passNote(s.passes.c1)).toBe('Replied 201 in 412 ms');
    expect(passNote({ reply: { status: 200, ms: 1249 } })).toBe('Replied 200 in 1.2 s');
    expect(reasonTitle('callFailed', call())).toBe("The call to your API didn't work");
    expect(reasonText('callFailed', call(), { reply: { status: 503, ms: 80 } })).toBe("Replied 503 in 80 ms, which this step doesn't count as a pass. The run stopped here.");
    expect(reasonTitle('callFailed', { action: 'write', label: 'Write the value CODE' })).toBe("The value from the call couldn't be typed");
  });
});

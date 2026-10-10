// Wait for an email (Breakpatch Team, issue #12) in the open app: the step's words in the list, the
// run view and the report, the recorder's action list taking an edition's action while its feature
// is on, the recorder sending the test inbox, a run reading it, and the preview engine failing the
// step without the feature. The step's dialog and Settings → Test inbox are the Team module's.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxSettings, Step } from '../data/types';
import type { RecorderActionDialogProps } from '../edition/types';
import { edition } from '../edition';
import { resetFeaturesForTests, setFeatures } from '../edition/features';
import { NO_FEATURES } from '../edition/types';
import { getEngine, type RunEnded } from '../engine';
import { DemoEngine } from '../engine/demoEngine';
import { emailLabel } from '../engine/labels';
import { DemoBackend, DEMO_WORKSPACE } from '../data/demo/demoBackend';
import { useSession } from '../state/session';
import { defaultLabel, emailNote, EMAIL_TOKENS, stepIcon, stepNote } from '../components/steps/stepText';
import { StepsPanel } from '../components/steps';
import { menuGroups } from '../screens/recorder/actions';
import { useRecorder } from '../screens/recorder/useRecorder';
import { INITIAL_RUN, runReducer } from '../screens/run/runState';
import { detailText, showsScreens } from '../screens/report/reportData';
import { keptNames } from './calls';
import { inboxSecretNames, keptChoiceLabel, keptValueLabel, readInbox } from './email';
import { gotNote, passNote, reasonAdvice, reasonText, reasonTitle } from './runWords';

Element.prototype.scrollIntoView ??= () => undefined;   // not in jsdom
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const APP = 'https://app.acme.com';
const INBOX: InboxSettings = { kind: 'imap', server: 'imap.acme.com', user: 'qa@acme.com', passwordRef: 'QA_INBOX', address: 'qa@acme.com' };
const wait = (over: Partial<Step> = {}): Step => ({ id: 'e1', action: 'emailWait', label: 'Wait for an email with a code', email: { to: '{email}', pick: 'code' }, ...over });

beforeEach(() => { useSession.setState({ workspace: DEMO_WORKSPACE, local: null }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); resetFeaturesForTests(); edition.slots.recorderActions = undefined; });

describe('a Wait for an email step in the list, the run and the report', () => {
  it('is named by what it picks out, and says where it waits and what it keeps', () => {
    expect(emailLabel({ pick: 'code' })).toBe('Wait for an email with a code');
    expect(emailLabel({ pick: 'link' })).toBe('Wait for an email with a link');
    expect(emailLabel(undefined)).toBe('Wait for an email');
    expect(defaultLabel({ action: 'emailWait', email: { pick: 'link' } })).toBe('Wait for an email with a link');
    expect(stepIcon(wait())).toBe('mail');
    expect(stepNote(wait())).toBe("To the run's own address · keeps the code for {emailCode}");
    expect(emailNote({ email: { to: 'qa@acme.com', pick: 'link' } })).toBe('To qa@acme.com · keeps the link for {emailLink}');
    expect(emailNote({})).toBe("To the run's own address");
    expect(defaultLabel({ action: 'write', valueRef: 'emailCode' })).toBe('Write the code from the email');
    expect(stepNote({ id: 'w', action: 'write', label: 'W', valueRef: 'emailLink' })).toBe('From the email');
    expect(EMAIL_TOKENS.map(t => t.token)).toEqual(['{email}', '{emailCode}', '{emailLink}']);
  });

  it('keeps emailCode or emailLink for the Write steps after it', () => {
    const call: Step = { id: 'c', action: 'call', label: 'Call', call: { method: 'POST', url: `${APP}/x` }, keep: { path: '$.a', name: 'A' } };
    expect(keptNames([wait(), wait({ id: 'e2', email: { pick: 'link' } }), wait({ id: 'e3', email: {} })])).toEqual(['emailCode', 'emailLink']);
    expect(keptChoiceLabel(['emailCode'])).toBe('From the email');
    expect(keptChoiceLabel(keptNames([call]))).toBe('From a call');
    expect(keptChoiceLabel(keptNames([call, wait()]))).toBe('From an earlier step');
    expect(keptValueLabel('emailCode')).toBe('The code from the email');
    expect(keptValueLabel('A')).toBe('A');
    expect(inboxSecretNames([wait()], INBOX)).toEqual(['QA_INBOX']);
    expect(inboxSecretNames([{ id: 'w', action: 'write', label: 'W', text: '{email}' }], INBOX)).toEqual([]);
    expect(inboxSecretNames([wait()], null)).toEqual([]);
  });

  it('says what came, never the value, and why one failed (report/view.py says the same)', () => {
    expect(gotNote({ got: 'code', chars: 6, digits: true, ms: 4210 })).toBe('Got a 6-digit code in 4.2 s');
    expect(gotNote({ got: 'code', chars: 8, digits: false, ms: 80 })).toBe('Got a code in 80 ms');
    expect(gotNote({ got: 'link', site: 'app.acme.com', ms: 3100 })).toBe('Got a link to app.acme.com in 3.1 s');
    expect(gotNote({ got: 'email' })).toBe('The email came');
    let s = runReducer(INITIAL_RUN, { type: 'start', runId: 'r', ids: ['e1'], at: 0 });
    s = runReducer(s, { type: 'step', ev: { runId: 'r', index: 0, stepId: 'e1', state: 'passed', email: { got: 'code', chars: 6, digits: true, ms: 900 } } });
    expect(passNote(s.passes.e1)).toBe('Got a 6-digit code in 900 ms');
    expect(reasonTitle('timeout', wait())).toBe('No email came in time');
    expect(reasonTitle('timeout', { action: 'click', label: 'Click' })).toBe('Waited too long for the page');
    expect(reasonTitle('actionUnavailable', wait())).toBe('This step needs Breakpatch Team');
    expect(reasonTitle('emailFailed', wait())).toBe("The test inbox couldn't be read");
    expect(reasonTitle('emailFailed', { action: 'write', label: 'W' })).toBe("What the email had couldn't be used");
    expect(reasonText('actionUnavailable', wait())).toMatch(/never passes without it/);
    expect(reasonText('timeout', wait())).toBe('No email this step waits for arrived in time. The run stopped here.');
    expect(reasonAdvice('timeout', wait())).toMatch(/sends the email/);
    expect(reasonAdvice('emailFailed')).toMatch(/Settings, Test inbox/);
    expect(showsScreens({ stepId: 'e1', result: 'failed', reason: 'timeout' }, wait())).toBe(false);
    expect(showsScreens({ stepId: 'e1', result: 'failed', reason: 'emailFailed' })).toBe(false);
    expect(detailText('passed', wait(), { stepId: 'e1', result: 'passed', email: { got: 'link', site: 'app.acme.com', ms: 1500 } }, false).body)
      .toBe('Got a link to app.acme.com in 1.5 s. Nothing from the email is kept after the run.');
  });
});

/** A stand-in for the Team module's dialog: Add step saves a code pick. */
function FakeDialog({ open, step, onSave, onClose }: RecorderActionDialogProps) {
  if (!open) return null;
  const save = async () => { if (await onSave({ email: { to: '{email}', pick: step ? 'link' : 'code' }, timeoutMs: 45000, label: 'Wait for the code' }) !== false) onClose(); };
  return (
    <div role="dialog" aria-label={step ? 'Edit the wait' : 'Wait for an email'}>
      <button type="button" onClick={() => void save()}>Save it</button>
      <button type="button" onClick={onClose}>Close it</button>
    </div>
  );
}
const FAKE = { kind: 'emailWait' as const, name: 'Wait for an email', icon: 'mail', group: 'Email', feature: 'email' as const, Dialog: FakeDialog };

describe("the recorder's action list and the edition's action", () => {
  it('takes its actions in their own group, before Structure', () => {
    const groups = menuGroups({ allowGroups: true, extra: [FAKE] });
    expect(groups.map(g => g.title)).toEqual(['Gestures', 'Input', 'Waiting', 'Browser', 'Checkpoint', 'API', 'Email', 'Structure']);
    expect(groups[6].items).toEqual([{ id: 'emailWait', kind: 'emailWait', name: 'Wait for an email', icon: 'mail', edition: true }]);
    expect(menuGroups({ allowGroups: true }).map(g => g.title)).not.toContain('Email');
  });

  it('offers Wait for an email only with the feature, adds the step through the engine with the inbox and its password', async () => {
    edition.slots.recorderActions = [FAKE];
    const backend = new DemoBackend();
    await backend.inbox.save(INBOX);
    useSession.setState({ backend });
    const spy = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 's1', action: 'emailWait', label: 'Wait for an email with a code', email: p.email, timeoutMs: p.timeoutMs }));
    const { AddStepBar } = await import('../screens/recorder/AddStepBar');
    function Bar() {
      const r = useRecorder({ viewport: { width: 1440, height: 900 }, onError: vi.fn(), appUrl: APP });
      return <><AddStepBar rec={r} appId="a" allowGroups onInsertGroup={() => undefined} describe={false} /><div data-testid="steps">{r.steps.map(s => s.label).join('|')}</div></>;
    }
    render(<Bar />);
    fireEvent.click(screen.getByRole('button', { name: /Click/, expanded: false }));
    expect(screen.queryByRole('menuitemradio', { name: /Wait for an email/ })).toBeNull();     // no feature: not offered
    fireEvent.click(screen.getByRole('button', { name: /Click/, expanded: true }));
    act(() => setFeatures({ ...NO_FEATURES, email: true }));
    fireEvent.click(screen.getByRole('button', { name: /Click/, expanded: false }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Wait for an email/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Wait for an email' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save it' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Wait for an email' })).toBeNull());
    expect(spy.mock.calls[0][0]).toEqual({ action: 'emailWait', email: { to: '{email}', pick: 'code' }, timeoutMs: 45000, label: 'Wait for the code',
      inbox: INBOX, appUrl: APP, secrets: {}, workspace: 'demo' });
    expect(screen.getByTestId('steps')).toHaveTextContent('Wait for the code');
    // Write: the inbox's tokens, and the code from the email.
    fireEvent.click(screen.getByRole('button', { name: /Click/, expanded: false }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Write text/ }));
    expect(await screen.findByRole('button', { name: 'Test inbox address' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'From the email' })).toBeInTheDocument();
  });

  it('sends the inbox with a Write of {email}, and none with plain text', async () => {
    const backend = new DemoBackend();
    useSession.setState({ backend });
    const spy = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: 's' + Math.random(), action: 'write', label: 'W', text: p.text }));
    const { result } = renderHook(() => useRecorder({ viewport: { width: 1440, height: 900 }, onError: vi.fn(), appUrl: APP }));
    await act(async () => { await result.current.record({ action: 'write', text: '{email}' }); });
    await act(async () => { await result.current.record({ action: 'write', text: 'Ada' }); });
    expect(spy.mock.calls[0][0]).toMatchObject({ inbox: { kind: 'mailpit', address: 'qa@staging.acme.example' }, appUrl: APP });
    expect(spy.mock.calls[1][0]).not.toHaveProperty('inbox');
  });

  it("edits the step in the edition's dialog, and isn't re-recorded", async () => {
    edition.slots.recorderActions = [FAKE];
    const onChange = vi.fn(), onEdited = vi.fn();
    render(<StepsPanel steps={[wait()]} mode="edit" selectedId="e1" onChange={onChange} onEdited={onEdited} onRerecord={vi.fn()} appUrl={APP} />);
    fireEvent.click(screen.getByRole('button', { name: 'More for this step' }));
    expect(screen.queryByRole('menuitem', { name: /Re-record/ })).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: /Edit/ }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Edit the wait' })).getByRole('button', { name: 'Save it' }));
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect((onChange.mock.calls[0][0] as Step[])[0]).toMatchObject({ id: 'e1', email: { pick: 'link' }, timeoutMs: 45000 });
    expect(onEdited).toHaveBeenCalledWith('e1', true);
  });
});

describe('a run with a Wait for an email step', () => {
  it('reads the test inbox once, with a timeout when the store never answers', async () => {
    const backend = new DemoBackend();
    expect(await readInbox(backend)).toMatchObject({ kind: 'mailpit' });
    await backend.inbox.save(null);
    expect(await readInbox(backend)).toBeNull();
    expect(await readInbox({ ...backend, inbox: undefined } as unknown as DemoBackend)).toBeNull();
  });

  it('fails in the preview without the feature, and passes with what came when it has it', async () => {
    const engine = new DemoEngine();
    const run = (id: string) => new Promise<RunEnded>(res => {
      const off = engine.on('run.ended', e => { if (e.runId === id) { off(); res(e); } });
      void engine.startRun({ runId: id, startUrl: APP, viewport: { width: 1440, height: 900, dpr: 1 }, steps: [wait()], settings: { autoFix: false, failOnFix: false }, secrets: {} });
    });
    const ended = await run('r1');
    expect(ended.result).toBe('fail');
    expect(ended.steps[0]).toMatchObject({ result: 'failed', reason: 'actionUnavailable' });
    setFeatures({ ...NO_FEATURES, email: true });
    const passed = await run('r2');
    expect(passed.result).toBe('pass');
    expect(passed.steps[0].email).toEqual({ got: 'code', chars: 6, digits: true, ms: 1800 });
  }, 15000);
});

// A Call step's editor (issue #44): the call (method, address, headers, body), which replies pass,
// how long to wait, and optionally a value to keep from the reply for a later Write step. Opens
// from the recorder's action menu (Add step makes the call, as recording any step does it) and from
// a Call step's Edit in the steps panel (Save changes the step; nothing is called).
import { useEffect, useState } from 'react';
import type { HttpCall, KeptValue, Step } from '../../data/types';
import { callLabel } from '../../engine/labels';
import { CALL_TIMEOUT_MAX_S, CALL_TIMEOUT_S, callStepProblem, cleanCall, DEFAULT_PASS } from '../../lib/calls';
import { secretNamesHere } from '../../lib/secretScope';
import { Button, Dialog, Field, Switch, TextInput } from '../ui';
import { CallFields } from './CallFields';

/** What the dialog saves into the step: the call and its options, and its name. */
export type CallStepPatch = Pick<Step, 'call' | 'passStatus' | 'timeoutMs' | 'keep' | 'label'>;

export function CallStepDialog({ open, step, appUrl, takenNames = [], onSave, onClose, adding }: {
  open: boolean;
  /** The step being edited; none for a new one. */
  step?: Step;
  appUrl: string;
  /** Names other Call steps in the test keep values as (a name keeps one value). */
  takenNames?: string[];
  /** Resolves false to stay open (adding a step whose call didn't work: the error says why). */
  onSave: (patch: CallStepPatch) => void | boolean | Promise<boolean | void>;
  onClose: () => void;
  /** A new step: "Add step" makes the call. */
  adding?: boolean;
}) {
  const [call, setCall] = useState<HttpCall>(step?.call ?? { method: 'POST', url: '' });
  const [otherHosts, setOtherHosts] = useState(!!step?.call?.allowOtherHosts);
  const [passStatus, setPassStatus] = useState(step?.passStatus ?? '');
  const [seconds, setSeconds] = useState(step?.timeoutMs ? Math.round(step.timeoutMs / 1000) : CALL_TIMEOUT_S);
  const [keepOn, setKeepOn] = useState(!!step?.keep);
  const [keep, setKeep] = useState<KeptValue>(step?.keep ?? { path: '$.', name: '' });
  const [label, setLabel] = useState(step?.label ?? '');
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  // Afresh each time it opens, from the step as it is then.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCall(step?.call ?? { method: 'POST', url: '' }); setOtherHosts(!!step?.call?.allowOtherHosts); setPassStatus(step?.passStatus ?? '');
      setSeconds(step?.timeoutMs ? Math.round(step.timeoutMs / 1000) : CALL_TIMEOUT_S); setKeepOn(!!step?.keep);
      setKeep(step?.keep ?? { path: '$.', name: '' }); setLabel(step?.label ?? ''); setTried(false); setBusy(false);
    }
  }
  useEffect(() => { if (open) void secretNamesHere().then(setSecretNames).catch(() => setSecretNames([])); }, [open]);

  const timeoutMs = Math.max(1, Math.min(CALL_TIMEOUT_MAX_S, seconds || CALL_TIMEOUT_S)) * 1000;
  const saved: Omit<CallStepPatch, 'label'> = {
    call: cleanCall(call, otherHosts),
    passStatus: passStatus.trim() && passStatus.trim() !== DEFAULT_PASS ? passStatus.trim() : undefined,
    timeoutMs: timeoutMs === CALL_TIMEOUT_S * 1000 ? undefined : timeoutMs,
    keep: keepOn ? { path: keep.path.trim(), name: keep.name.trim() } : undefined,
  };
  const problem = callStepProblem(saved, appUrl, takenNames.filter(n => n !== step?.keep?.name));
  const auto = step ? callLabel(step.call) : '';

  const save = async () => {
    setTried(true);
    if (problem || busy) return;
    // A name left as it was follows what the call now does.
    const name = !step || label.trim() === '' || label.trim() === auto ? callLabel(saved.call) : label.trim();
    setBusy(true);
    try {
      const done = await onSave({ ...saved, label: name });
      if (done !== false) onClose();
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title={step ? 'Edit the call' : 'Call your API'} icon="api" width={600}
      sub={adding ? 'Add step calls it now, as a run will at this step. The next steps then start from what it did.' : 'Each run calls it at this step and waits for the reply.'}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" busy={busy} onClick={() => void save()}>{adding ? 'Add step' : 'Save'}</Button>
      </>}>
      <form className="app-form app-call-step" onSubmit={e => { e.preventDefault(); void save(); }}>
        {step && <TextInput label="Name" value={label} onChange={e => setLabel(e.target.value)} placeholder={callLabel(saved.call)} />}
        <CallFields title="Call" call={call} onChange={setCall} error={tried ? problem : undefined} appUrl={appUrl} otherHosts={otherHosts}
          secretNames={secretNames} body step={{ passStatus: saved.passStatus, timeoutMs, ...(saved.keep ? { keep: saved.keep } : {}) }}>
          <div className="app-call-opts">
            <TextInput label="Replies that pass" mono value={passStatus} placeholder={DEFAULT_PASS} onChange={e => setPassStatus(e.target.value)}
              hint="For example 2xx, or 200, 404. Redirects never pass." spellCheck={false} autoCapitalize="off" />
            <TextInput label="Wait, seconds" type="number" min={1} max={CALL_TIMEOUT_MAX_S} value={seconds} onChange={e => setSeconds(Number(e.target.value) || CALL_TIMEOUT_S)} />
          </div>
          <label className="app-hooks-switch">
            <Switch checked={keepOn} onChange={setKeepOn} label="Keep a value from the reply" />
            <span>Keep a value from the reply<span className="app-hooks-hint">A Write step after this one can type it, for example a one-time code. It isn't saved with the test or logged, but typed into a field you can see, it can show in a screenshot.</span></span>
          </label>
          {keepOn && (
            <Field>
              <div className="app-call-keep">
                <TextInput aria-label="Where the value is in the reply" label="Where in the reply" mono value={keep.path} placeholder="$.code" spellCheck={false} autoCapitalize="off"
                  onChange={e => setKeep({ ...keep, path: e.target.value })} />
                <TextInput aria-label="Name of the value" label="Name" mono value={keep.name} placeholder="CODE" spellCheck={false} autoCapitalize="off"
                  onChange={e => setKeep({ ...keep, name: e.target.value })} />
              </div>
            </Field>
          )}
          <label className="app-hooks-switch">
            <Switch checked={otherHosts} onChange={setOtherHosts} label="Allow other hosts" />
            <span>Allow other hosts<span className="app-hooks-hint">Calls go to {hostOf(appUrl)} and its sibling hosts over https. Turn this on to call another host or a private address.</span></span>
          </label>
        </CallFields>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the app'; }
}

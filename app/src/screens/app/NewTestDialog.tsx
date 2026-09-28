// New test: name, description, start address, locked screen size, optional
// set-up and clean-up calls (ui-requirements §5.5).
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Field, Icon, IconButton, Select, Spinner, Switch, TextInput, useToast } from '../../components/ui';
import { sizeLabel } from '../../components/common';
import { useBackend } from '../../data/hooks';
import type { App, CallHeader, HttpCall } from '../../data/types';
import { getEngine } from '../../engine';
import { secrets } from '../../platform';
import { callProblem, cleanCall, describeReply, isHttpAddress, tryCall, type Reply } from './tryCall';

const METHODS: HttpCall['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];


export function NewTestDialog({ open, app, onClose }: { open: boolean; app: App; onClose: () => void }) {
  const backend = useBackend();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startUrl, setStartUrl] = useState(app.baseUrl);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [setUp, setSetUp] = useState<HttpCall>({ method: 'POST', url: '' });
  const [cleanUp, setCleanUp] = useState<HttpCall>({ method: 'POST', url: '' });
  const [alsoOnFailure, setAlsoOnFailure] = useState(true);
  const [otherHosts, setOtherHosts] = useState(false);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(''); setDescription(''); setStartUrl(app.baseUrl); setHooksOpen(false);
    setSetUp({ method: 'POST', url: '' }); setCleanUp({ method: 'POST', url: '' }); setAlsoOnFailure(true); setOtherHosts(false);
    setTried(false); setBusy(false);
    void secrets.list().then(setSecretNames).catch(() => setSecretNames([]));
  }, [open, app.baseUrl]);

  const nameErr = tried && !name.trim() ? 'Give the test a name.' : undefined;
  const urlErr = tried && !isHttpAddress(startUrl) ? 'Enter a full address, starting with https://' : undefined;
  // The same rules the engine applies (engine/PROTOCOL.md "Set-up and clean-up calls").
  const setUpProblem = callProblem({ ...setUp, allowOtherHosts: otherHosts }, app.baseUrl);
  const cleanUpProblem = callProblem({ ...cleanUp, allowOtherHosts: otherHosts }, app.baseUrl);
  const setUpErr = tried ? setUpProblem : undefined;
  const cleanUpErr = tried ? cleanUpProblem : undefined;

  const start = async () => {
    setTried(true);
    if (!name.trim() || !isHttpAddress(startUrl)) return;
    if (setUpProblem || cleanUpProblem) { setHooksOpen(true); return; }
    setBusy(true);
    try {
      const t = await backend.createTest({
        appId: app.id, name: name.trim(), description: description.trim() || undefined, startUrl: startUrl.trim(), viewport: app.defaultViewport,
        setUp: setUp.url.trim() ? cleanCall(setUp, otherHosts) : undefined,
        cleanUp: cleanUp.url.trim() ? { ...cleanCall(cleanUp, otherHosts), alsoOnFailure } : undefined,
      });
      onClose();
      navigate(`/apps/${app.id}/tests/${t.id}/record`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the test", { error: true });
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New test" width={520}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" icon="radio_button_checked" busy={busy} onClick={start}>Start recording</Button>
      </>}>
      <form className="app-form" onSubmit={e => { e.preventDefault(); void start(); }}>
        <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="For example: Create a project" error={nameErr} autoFocus />
        <TextInput label={<span className="app-label-split">Description<span>Optional</span></span>} value={description}
          onChange={e => setDescription(e.target.value)} placeholder="What this test checks" />
        <TextInput label="Start address" mono value={startUrl} onChange={e => setStartUrl(e.target.value)} error={urlErr} spellCheck={false} autoCapitalize="off" />
        <div className="app-lock" role="note"><Icon name="lock" size={18} />Screen size {sizeLabel(app.defaultViewport)}. You can't change it later.</div>

        <div className="app-hooks">
          <button type="button" className="app-hooks-toggle" aria-expanded={hooksOpen} onClick={() => setHooksOpen(o => !o)}>
            <Icon name="chevron_right" size={20} className="app-hooks-chev" />
            <span className="grow">Before and after the test</span>
            <span className="faint app-hooks-opt">Optional</span>
          </button>
          {hooksOpen && (
            <div className="app-hooks-body">
              <div className="app-hooks-intro">Call your own address to set up test data first and clean it up afterwards. Each run waits for a reply before carrying on.</div>
              <CallCard icon="database" title="Before: set up data" sub="Called before step 1" call={setUp} onChange={setSetUp} error={setUpErr}
                app={app} otherHosts={otherHosts} secretNames={secretNames} />
              <CallCard icon="mop" title="After: clean up" sub="Called after the last step" call={cleanUp} onChange={setCleanUp} error={cleanUpErr}
                app={app} otherHosts={otherHosts} secretNames={secretNames}>
                <label className="app-hooks-switch">
                  <Switch checked={alsoOnFailure} onChange={setAlsoOnFailure} label="Also clean up when the test fails or is stopped" />
                  <span>Also clean up when the test fails or is stopped</span>
                </label>
              </CallCard>
              <label className="app-hooks-switch">
                <Switch checked={otherHosts} onChange={setOtherHosts} label="Allow other hosts" />
                <span>Allow other hosts<span className="app-hooks-hint">Calls go to {hostOf(app.baseUrl)} and its sibling hosts over https. Turn this on to call another host or a private address.</span></span>
              </label>
              <div className="app-hooks-foot">If the set-up call fails, the run stops before step 1 and says so in the report. Redirects aren't followed.</div>
            </div>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return 'the app'; }
}

function CallCard({ icon, title, sub, call, onChange, error, app, otherHosts, secretNames, children }: {
  icon: string; title: string; sub: string; call: HttpCall; onChange: (c: HttpCall) => void; error?: string;
  app: App; otherHosts: boolean; secretNames: string[]; children?: ReactNode;
}) {
  const [reply, setReply] = useState<Reply | null>(null);
  const [trying, setTrying] = useState(false);
  const headers = call.headers ?? [];
  useEffect(() => { setReply(null); }, [call.url, call.method, call.headers, otherHosts]);
  const tryIt = async () => {
    setTrying(true);
    const c = cleanCall(call, otherHosts);
    const names = (c.headers ?? []).map(h => h.secretRef).filter((n): n is string => !!n);
    const values = names.length ? await secrets.resolve(names).catch(() => ({})) : {};
    setReply(await tryCall(c, { engine: getEngine(), appUrl: app.baseUrl, secrets: values }));
    setTrying(false);
  };
  const setHeader = (i: number, h: CallHeader) => onChange({ ...call, headers: headers.map((x, j) => (j === i ? h : x)) });

  return (
    <div className="app-call">
      <div className="app-call-head">
        <span className="app-call-disc"><Icon name={icon} size={18} /></span>
        <div className="grow col" style={{ gap: 1 }}><div className="app-call-title">{title}</div><div className="app-call-sub">{sub}</div></div>
      </div>
      <Field error={error}>
        <div className="app-call-row">
          <div className="app-call-method">
            <Select aria-label={`${title}: method`} value={call.method} onChange={e => onChange({ ...call, method: e.target.value as HttpCall['method'] })}
              options={METHODS.map(m => ({ value: m, label: m }))} />
          </div>
          <TextInput aria-label={`${title}: address`} mono value={call.url} placeholder="https://api.example.com/test/seed" spellCheck={false} autoCapitalize="off"
            onChange={e => onChange({ ...call, url: e.target.value })} />
        </div>
      </Field>
      {headers.map((h, i) => (
        <div className="app-call-header" key={i}>
          <TextInput aria-label={`${title}: header ${i + 1} name`} mono value={h.name} placeholder="Authorization" spellCheck={false} autoCapitalize="off"
            onChange={e => setHeader(i, { ...h, name: e.target.value })} />
          <div className="app-call-method">
            <Select aria-label={`${title}: header ${i + 1} value from`} value={h.secretRef !== undefined ? 'secret' : 'text'}
              onChange={e => setHeader(i, e.target.value === 'secret' ? { name: h.name, secretRef: secretNames[0] ?? '' } : { name: h.name, value: '' })}
              options={[{ value: 'text', label: 'Text' }, { value: 'secret', label: 'Saved secret' }]} />
          </div>
          {h.secretRef !== undefined
            ? <Select aria-label={`${title}: header ${i + 1} secret`} value={h.secretRef} onChange={e => setHeader(i, { ...h, secretRef: e.target.value })}
                options={secretNames.length ? secretNames.map(n => ({ value: n, label: n })) : [{ value: '', label: 'No saved secrets on this Mac' }]} />
            : <TextInput aria-label={`${title}: header ${i + 1} value`} mono value={h.value ?? ''} spellCheck={false} autoCapitalize="off"
                onChange={e => setHeader(i, { ...h, value: e.target.value })} />}
          <IconButton icon="close" label={`Remove header ${h.name || i + 1}`} onClick={() => onChange({ ...call, headers: headers.filter((_, j) => j !== i) })} />
        </div>
      ))}
      <div className="app-call-try">
        <div className="grow" aria-live="polite">
          {trying ? <span className="app-reply"><Spinner size={16} />Calling…</span>
            : reply && <span className={`app-reply ${reply.ok ? 'ok' : 'bad'}`}><Icon name={reply.ok ? 'check_circle' : 'error'} size={16} />{describeReply(reply)}</span>}
        </div>
        <Button kind="link" size="sm" icon="add" onClick={() => onChange({ ...call, headers: [...headers, { name: '', value: '' }] })}>Add header</Button>
        <Button kind="link" size="sm" icon="send" disabled={!call.url.trim() || trying} onClick={tryIt}>Try it</Button>
      </div>
      {children}
    </div>
  );
}

// New test: name, description, start address, screen size (the app's, or a phone or tablet), optional
// set-up and clean-up calls (ui-requirements §5.5).
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Field, Icon, Switch, TextInput, useToast } from '../../components/ui';
import { CallFields } from '../../components/calls/CallFields';
import { SizePicker } from '../../components/common';
import { useBackend } from '../../data/hooks';
import type { App, HttpCall, Viewport } from '../../data/types';
import { secretNamesHere } from '../../lib/secretScope';
import { callProblem, cleanCall, isHttpAddress } from '../../lib/calls';
import { withScheme } from './TestDetailsDialog';


export function NewTestDialog({ open, app, onClose }: { open: boolean; app: App; onClose: () => void }) {
  const backend = useBackend();
  const navigate = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [startUrl, setStartUrl] = useState(app.baseUrl);
  const [viewport, setViewport] = useState<Viewport>(app.defaultViewport);
  const [hooksOpen, setHooksOpen] = useState(false);
  const [setUp, setSetUp] = useState<HttpCall>({ method: 'POST', url: '' });
  const [cleanUp, setCleanUp] = useState<HttpCall>({ method: 'POST', url: '' });
  const [alsoOnFailure, setAlsoOnFailure] = useState(true);
  const [otherHosts, setOtherHosts] = useState(false);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  // Starts afresh each time it opens, from the app as it is then. Only opening resets it: the app
  // comes again as a new object whenever the workspace sends an update, and what was typed stays.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setName(''); setDescription(''); setStartUrl(app.baseUrl); setViewport(app.defaultViewport); setHooksOpen(false);
      setSetUp({ method: 'POST', url: '' }); setCleanUp({ method: 'POST', url: '' }); setAlsoOnFailure(true); setOtherHosts(false);
      setTried(false); setBusy(false);
    }
  }
  useEffect(() => {
    if (open) void secretNamesHere().then(setSecretNames).catch(() => setSecretNames([]));
  }, [open]);

  const nameErr = tried && !name.trim() ? 'Give the test a name.' : undefined;
  const urlErr = tried && !isHttpAddress(withScheme(startUrl)) ? 'Enter a full address, like https://app.example.com' : undefined;
  // The same rules the engine applies (engine/PROTOCOL.md "Set-up and clean-up calls").
  const setUpProblem = callProblem({ ...setUp, allowOtherHosts: otherHosts }, app.baseUrl);
  const cleanUpProblem = callProblem({ ...cleanUp, allowOtherHosts: otherHosts }, app.baseUrl);
  const setUpErr = tried ? setUpProblem : undefined;
  const cleanUpErr = tried ? cleanUpProblem : undefined;

  const start = async () => {
    setTried(true);
    if (!name.trim() || !isHttpAddress(withScheme(startUrl))) return;
    if (setUpProblem || cleanUpProblem) { setHooksOpen(true); return; }
    setBusy(true);
    try {
      const t = await backend.createTest({
        appId: app.id, name: name.trim(), description: description.trim() || undefined, startUrl: withScheme(startUrl), viewport,
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
        <TextInput label="Start address" mono value={startUrl} onChange={e => setStartUrl(e.target.value)} onBlur={() => setStartUrl(withScheme(startUrl))} error={urlErr} spellCheck={false} autoCapitalize="off" />
        <Field label="Screen size">
          <SizePicker value={viewport} onChange={setViewport} />
        </Field>
        <div className="app-lock" role="note"><Icon name="lock" size={18} />You can't change the screen size later.</div>

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
  return (
    <div className="app-call">
      <div className="app-call-head">
        <span className="app-call-disc"><Icon name={icon} size={18} /></span>
        <div className="grow col" style={{ gap: 1 }}><div className="app-call-title">{title}</div><div className="app-call-sub">{sub}</div></div>
      </div>
      <CallFields title={title} call={call} onChange={onChange} error={error} appUrl={app.baseUrl} otherHosts={otherHosts} secretNames={secretNames} />
      {children}
    </div>
  );
}

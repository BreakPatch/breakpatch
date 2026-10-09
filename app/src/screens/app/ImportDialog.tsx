// Import a Playwright or Cypress test (roadmap #16): pick a script (or paste one), see the steps it
// maps to and the lines it leaves out, then create the test. The script is read here and never
// run (lib/scriptImport). The new test opens in the recorder, which learns each step's screen
// checks by doing it once (plan.ts, `auto`); the person saves it when that's done.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Dialog, Field, Icon, Select, TextArea, TextInput, useToast } from '../../components/ui';
import { SCREEN_SIZES, SizePicker } from '../../components/common';
import { useBackend } from '../../data/hooks';
import type { App, Viewport } from '../../data/types';
import { openNamedTextFile } from '../../platform';
import { importScript, leftOutNote, MAX_SCRIPT_BYTES, NOTHING_FOUND, SCRIPT_EXTENSIONS, toWalk, withBase, withSecrets, type ScriptImport } from '../../lib/scriptImport';
import { holdImport } from '../../lib/scriptImport/pending';
import { secretNamesHere } from '../../lib/secretScope';
import { planSentence } from '../recorder/plan';
import { isHttpAddress } from '../../lib/calls';
import { withScheme } from './TestDetailsDialog';
import './import.css';

const TOO_BIG = 'This file is too big to be a test script.';

interface Read { file: string; result: ScriptImport }

export function ImportDialog({ open, app, onClose }: { open: boolean; app: App; onClose: () => void }) {
  const backend = useBackend();
  const navigate = useNavigate();
  const toast = useToast();
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [which, setWhich] = useState(0);
  const [name, setName] = useState('');
  const [startUrl, setStartUrl] = useState(app.baseUrl);
  const [viewport, setViewport] = useState<Viewport>(app.defaultViewport);
  const [showNotNeeded, setShowNotNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState(false);

  // Starts afresh each time it opens.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) { setRead(null); setError(null); setPasting(false); setPasted(''); setBusy(false); setTried(false); }
  }

  const test = read?.result.tests[which];
  const full = test ? withBase(test, app.baseUrl) : undefined;
  // A script just read (or another test picked in it): its name, start address and screen size.
  const [seq, setSeq] = useState(0);
  const [shown, setShown] = useState('');
  if (full && shown !== `${seq}:${which}`) {
    setShown(`${seq}:${which}`);
    setName(full.name);
    setStartUrl(full.startUrl ?? app.baseUrl);
    const preset = full.viewport && SCREEN_SIZES.find(s => s.viewport.width === full.viewport!.width && s.viewport.height === full.viewport!.height);
    setViewport(preset ? preset.viewport : app.defaultViewport);
    setShowNotNeeded(false);
  }

  const take = (file: string, text: string) => {
    let result: ScriptImport;
    try { result = importScript(text, file); }
    catch { setError("Couldn't read this script. Check it's a JavaScript or TypeScript file."); return; }
    if (!result.tests.length) { setError(NOTHING_FOUND); return; }
    setError(null); setRead({ file, result }); setWhich(0); setTried(false); setSeq(n => n + 1);
  };
  const choose = async () => {
    try {
      const f = await openNamedTextFile(SCRIPT_EXTENSIONS, 'Test scripts', { maxBytes: MAX_SCRIPT_BYTES, tooBig: TOO_BIG });
      if (f) take(f.name, f.text);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't read that file.");
    }
  };

  const address = withScheme(startUrl.trim());
  const nameErr = tried && !name.trim() ? 'Give the test a name.' : undefined;
  const urlErr = tried && !isHttpAddress(address) ? 'Enter a full address, like https://app.example.com' : undefined;
  const steps = full?.steps ?? [];

  const create = async () => {
    setTried(true);
    if (!full || !steps.length || !name.trim() || !isHttpAddress(address)) return;
    setBusy(true);
    try {
      const names = await secretNamesHere().catch(() => [] as string[]);
      const t = await backend.createTest({ appId: app.id, name: name.trim(), startUrl: address, viewport });
      holdImport(app.id, t.id, { steps: withSecrets(steps, names).map(toWalk), note: leftOutNote(full) });
      onClose();
      navigate(`/apps/${app.id}/tests/${t.id}/record`);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't create the test", { error: true });
      setBusy(false);
    }
  };

  const tool = read?.result.framework === 'cypress' ? 'Cypress' : 'Playwright';
  const missing = full?.skipped.filter(s => !s.notNeeded) ?? [];
  const notNeeded = full?.skipped.filter(s => s.notNeeded) ?? [];
  const scriptSize = full?.viewport && !SCREEN_SIZES.some(s => s.viewport.width === full.viewport!.width && s.viewport.height === full.viewport!.height)
    ? `The script uses ${full.viewport.width} × ${full.viewport.height}. Pick the size closest to it.` : undefined;

  return (
    <Dialog open={open} onClose={onClose} title="Import a test" icon="upload_file" width={read ? 680 : 520}
      sub={read ? `${tool} · ${read.file || 'pasted script'}` : 'From a Playwright or Cypress script. Breakpatch reads the script and never runs it.'}
      actions={read ? <>
        <Button onClick={() => { setRead(null); setError(null); }} disabled={busy}>Another script</Button>
        <span className="grow" />
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button kind="primary" icon="play_circle" busy={busy} disabled={!steps.length} onClick={() => void create()}>Create and learn</Button>
      </> : <Button onClick={onClose}>Cancel</Button>}>
      {!read ? (
        <div className="imp-pick">
          <Button kind="primary" size="lg" icon="folder_open" onClick={() => void choose()}>Choose a script…</Button>
          <div className="imp-hint">A Playwright test (<span className="mono">.spec.ts</span>, or what <span className="mono">npx playwright codegen</span> writes) or a Cypress test (<span className="mono">.cy.js</span>, <span className="mono">.cy.ts</span>).</div>
          {!pasting
            ? <Button kind="link" size="sm" onClick={() => setPasting(true)}>Paste the script instead</Button>
            : (
              <form className="imp-paste" onSubmit={e => { e.preventDefault(); if (pasted.trim()) take('', pasted); }}>
                <TextArea label="Script" mono rows={8} value={pasted} autoFocus spellCheck={false}
                  placeholder={"test('Sign in', async ({ page }) => {\n  await page.goto('/login');\n  …"}
                  onChange={e => { setPasted(e.target.value); setError(null); }} />
                <div><Button type="submit" disabled={!pasted.trim()}>Read the script</Button></div>
              </form>
            )}
          {error && <div className="imp-error" role="alert"><Icon name="error" size={18} />{error}</div>}
        </div>
      ) : full && (
        <form className="imp-preview" onSubmit={e => { e.preventDefault(); void create(); }}>
          {read.result.tests.length > 1 && (
            <Select label={`Test (${read.result.tests.length} in this script)`} value={String(which)} onChange={e => setWhich(Number(e.target.value))}
              options={read.result.tests.map((t, i) => ({ value: String(i), label: `${t.name} · ${t.steps.length === 1 ? '1 step' : `${t.steps.length} steps`}` }))} />
          )}
          <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} error={nameErr} />
          <TextInput label="Start address" mono value={startUrl} onChange={e => setStartUrl(e.target.value)} onBlur={() => setStartUrl(withScheme(startUrl))}
            error={urlErr} spellCheck={false} autoCapitalize="off"
            hint={test?.startUrl === undefined ? "The script doesn't open an address first, so the test starts at the app's address." : undefined} />
          <Field label="Screen size" hint={scriptSize}>
            <SizePicker value={viewport} onChange={setViewport} />
          </Field>

          <section className="imp-section" aria-label="Steps">
            <h3 className="imp-h">{steps.length === 1 ? '1 step' : `${steps.length} steps`}</h3>
            {steps.length ? (
              <ol className="imp-steps">
                {steps.map((s, i) => (
                  <li key={i} className="imp-step">
                    <span className="imp-n">{i + 1}</span>
                    <span className="grow">
                      {planSentence(s)}
                      {s.guessed && <span className="imp-check" title="Worked out from the page's code, or from a narrower locator. Learning stops at this step for you to confirm it's the right thing.">Check</span>}
                      {s.note && <span className="imp-note">{s.note}</span>}
                      {s.secretHint && s.needs === 'secret' && <span className="imp-note">The script reads {s.secretHint}. You pick the saved secret to type when it's learned.</span>}
                    </span>
                    <span className="imp-line">Line {s.line}</span>
                  </li>
                ))}
              </ol>
            ) : <div className="imp-error" role="alert"><Icon name="error" size={18} />Nothing in this test can be a step. Record it by clicking instead.</div>}
          </section>

          {missing.length > 0 && (
            <section className="imp-section" aria-label="Not imported">
              <h3 className="imp-h">Not imported <span className="faint">· {missing.length}</span></h3>
              <ul className="imp-skips">
                {missing.map((s, i) => <Skipped key={i} line={s.line} code={s.code} why={s.why} />)}
              </ul>
            </section>
          )}
          {notNeeded.length > 0 && (
            <section className="imp-section">
              <button type="button" className="imp-toggle" aria-expanded={showNotNeeded} onClick={() => setShowNotNeeded(o => !o)}>
                <Icon name="chevron_right" size={18} className="imp-chev" />Not needed <span className="faint">· {notNeeded.length}</span>
              </button>
              {showNotNeeded && <ul className="imp-skips">{notNeeded.map((s, i) => <Skipped key={i} line={s.line} code={s.code} why={s.why} />)}</ul>}
            </section>
          )}
          <div className="imp-next" role="note">
            <Icon name="play_circle" size={18} />
            <span>Next, Breakpatch opens the test and does each step once, to learn how the screens should look. It stops and asks when it can't find something. Save the test when it's done.</span>
          </div>
          <button type="submit" hidden />
        </form>
      )}
    </Dialog>
  );
}

function Skipped({ line, code, why }: { line: number; code: string; why: string }) {
  return (
    <li className="imp-skip">
      <div className="imp-skip-code"><span className="imp-line">Line {line}</span><code className="mono">{code}</code></div>
      <div className="imp-skip-why">{why}</div>
    </li>
  );
}

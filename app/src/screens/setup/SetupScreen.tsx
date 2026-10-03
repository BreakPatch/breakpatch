// Setup (design "Setup"): automatic checklist. Nothing else opens until it's done (App.tsx gate).
import { useEffect, useState } from 'react';
import { Button, CopyButton, Icon } from '../../components/ui';
import { getEngine } from '../../engine';
import { appVersion } from '../../platform';
import { useSession } from '../../state/session';
import type { TaskState } from '../../state/session';
import { BrandPanel, GateSplit } from '../../components/shell/GateWindow';
import { firstNameOf } from '../../data/local/folder';
import { baseName } from '../../data/local/storage';
import { ROWS, SetupRunner, type Row, type RowKey, type SetupSnapshot } from './setupRunner';
import './setup.css';
import { useSystem } from '../../state/system';
import { startingText } from '../../components/shell/EngineStarting';
import { Computer, osText, ThisComputer } from '../../lib/osWords';

const NAMES: Record<RowKey, string> = { browser: 'Installing the test browser', mac: 'Checking this Mac', model: 'Downloading the AI assistant' };
const LOOK: Record<TaskState, { icon: string; word: string; cls: string }> = {
  waiting: { icon: 'radio_button_unchecked', word: 'Next', cls: 'waiting' },
  busy: { icon: 'progress_activity', word: '', cls: 'busy' },
  paused: { icon: 'pause_circle', word: 'Paused', cls: 'paused' },
  done: { icon: 'check_circle', word: 'Done', cls: 'done' },
  failed: { icon: 'error', word: "Didn't work", cls: 'failed' },
};
const FAILED_LEDE: Record<RowKey, string> = {
  browser: "The test browser didn't install. The rest waits until it does.",
  mac: "This Mac couldn't be checked. The rest waits until it is.",
  model: "The AI assistant didn't download. The rest is ready.",
};

function size(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}
function amount(done: number, total: number): string {
  return total >= 1e9 ? `${(done / 1e9).toFixed(1)} of ${size(total)}` : `${size(done)} of ${size(total)}`;
}
function eta(s?: number): string {
  if (s == null) return '';
  return s < 60 ? ' · less than a minute left' : ` · about ${Math.round(s / 60)} min left`;
}
const pct = (r: Row) => (r.totalBytes ? Math.min(1, (r.doneBytes ?? 0) / r.totalBytes) : 0);

function useSetupRunner() {
  const [runner, setRunner] = useState<SetupRunner | null>(null);
  const [snap, setSnap] = useState<SetupSnapshot | null>(null);
  const online = useSession(s => s.online);
  useEffect(() => {
    const r = new SetupRunner(getEngine());
    setRunner(r); setSnap(r.state);
    const off = r.subscribe(setSnap);
    r.start();
    return () => { off(); r.dispose(); };
  }, []);
  useEffect(() => { if (!online) void runner?.pause(); }, [online, runner]);
  return { runner, snap };
}

export default function SetupScreen() {
  const user = useSession(s => s.user);
  const ws = useSession(s => s.workspace);
  const local = useSession(s => s.local);
  const setSetupDone = useSession(s => s.setSetupDone);
  const { runner, snap } = useSetupRunner();
  const engineReady = useSystem(s => s.engineReady);
  const firstStart = useSystem(s => s.firstEngineStart);
  if (!snap || !runner) return null;

  const rows = snap.rows;
  const failed = ROWS.find(k => rows[k].state === 'failed');
  const paused = ROWS.find(k => rows[k].state === 'paused');
  const ready = ROWS.every(k => rows[k].state === 'done');
  const first = firstNameOf(user);
  const modelLabel = snap.model?.label.toLowerCase() ?? 'standard';

  const note = (k: RowKey, r: Row): string | undefined => {
    if (r.state === 'paused' || r.state === 'failed') return r.reason;
    // Until the engine first answers, the first row says what is going on instead of sitting at 0%.
    if (!engineReady && k === ROWS[0] && r.state !== 'done') return startingText(firstStart);
    if (r.state !== 'done') return undefined;
    if (k === 'mac' && snap.info) return `${ThisComputer()} has ${snap.info.memoryGb} GB of memory, so you get the ${modelLabel} AI assistant${snap.modelBytes ? ` (${size(snap.modelBytes)})` : ''}.`;
    if (k === 'model' && snap.modelBytes) return `${size(snap.modelBytes)}, checked and ready.`;
    return undefined;
  };

  let heading: string, lede: string, foot = '';
  if (failed) { heading = "Setup couldn't finish"; lede = osText(FAILED_LEDE[failed]); foot = 'Still stuck? Send the details to a developer.'; }
  else if (paused) {
    const r = rows[paused];
    const at = r.doneBytes ? (r.totalBytes && r.totalBytes >= 1e9 ? `${(r.doneBytes / 1e9).toFixed(1)} GB` : size(r.doneBytes)) : null;
    heading = 'Setup paused';
    lede = at ? `The download stopped at ${at}. Nothing's lost.` : "The download stopped. Nothing's lost.";
    foot = at ? `Continues from ${at}, not from the start.` : 'Continues where it stopped, not from the start.';
  } else if (ready) { heading = "You're set up."; lede = osText("The browser and AI assistant are on this Mac. You won't see this again."); }
  else { heading = osText('Getting this Mac ready'); lede = 'Takes about 5 minutes on office Wi-Fi. You can leave it running.'; foot = 'Safe to close. It picks up where it left off.'; }

  const details = failed ? [
    `Breakpatch ${appVersion()} setup`,
    `Task: ${osText(NAMES[failed])}`,
    `Reason: ${rows[failed].reason ?? ''}`,
    rows[failed].details,
    snap.info && `${Computer()}: ${snap.info.chip}, ${snap.info.memoryGb} GB, ${snap.info.os}, engine ${snap.info.engineVersion}`,
    snap.model && `AI assistant: ${snap.model.repo}@${snap.model.revision}`,
  ].filter(Boolean).join('\n') : '';

  const brand = (
    <BrandPanel heading={<div className="gi-brand-hello">{paused ? 'Welcome back.' : first ? `Welcome, ${first}.` : 'Welcome.'}</div>}
      line="Breakpatch tests your web apps by looking at them, the way a person would."
      foot={local
        ? <><Icon name="folder" />Tests saved in {baseName(local.path)}</>
        : <><Icon name="account_circle" />{ws?.name} workspace{user?.email ? ` · ${user.email}` : ''}</>} />
  );

  return (
    <GateSplit width={500} brand={brand} top>
      <div className="gi-head" style={{ gap: 6 }}>
        <h1 className="gi-title" aria-live="polite">{heading}</h1>
        <p className="gi-lede">{lede}</p>
      </div>
      <ol className="gi-box su-list" aria-label="Setup">
        {ROWS.map(k => {
          const r = rows[k], look = LOOK[r.state], n = note(k, r);
          const withBar = k === 'model' && (r.state === 'busy' || r.state === 'paused') && !!r.totalBytes;
          const word = r.state === 'busy' ? (r.totalBytes ? `${Math.floor(pct(r) * 100)}%` : '') : look.word;
          return (
            <li key={k} className={'su-row ' + look.cls}>
              <Icon name={look.icon} className="su-icon" label={look.word || 'Working'} />
              <div className="grow col" style={{ gap: 6 }}>
                <div className="su-top"><div className="su-name">{osText(NAMES[k])}</div>{word && <div className="su-state">{word}</div>}</div>
                {n && <div className="su-note">{n}</div>}
                {withBar && (
                  <>
                    <div className="su-bar" role="progressbar" aria-label="AI assistant download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct(r) * 100)}>
                      <div style={{ width: `${pct(r) * 100}%` }} />
                    </div>
                    <div className="su-bar-text">{amount(r.doneBytes ?? 0, r.totalBytes!)}{r.state === 'busy' ? eta(r.etaSeconds) : ''}</div>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="su-actions">
        {failed && <Button kind="primary" size="lg" icon="replay" onClick={() => runner.retry()} autoFocus>Try again</Button>}
        {failed && <CopyButton text={details} label="Copy details" size="lg" />}
        {!failed && paused && <Button kind="primary" size="lg" icon="play_arrow" onClick={() => runner.start()} autoFocus>Resume</Button>}
        {ready && <Button kind="primary" size="lg" icon="arrow_forward" onClick={() => setSetupDone(true)} autoFocus>Open Breakpatch</Button>}
        {foot && <div className="gi-foot-note grow">{foot}</div>}
      </div>
    </GateSplit>
  );
}

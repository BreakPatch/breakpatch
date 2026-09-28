import { useState } from 'react';
import { Button, CopyButton, EarMark, Icon, StatusPill, Wordmark } from '../../../components/ui';
import { appVersion, isTauri } from '../../../platform';
import { checkForUpdates, restartToUpdate, type CheckResult } from '../../../lib/updates';
import { useSession } from '../../../state/session';
import { useSystem } from '../../../state/system';
import { clock, daysAgo, formatDateTime } from '../../../components/common/format';
import { Fact, Section } from './common';
import { baseName } from '../../../data/local/storage';
import { modelSize, useSystemInfo } from './AiSection';
import { edition } from '../../../edition';
import { EditionMismatch, editionLabel } from './edition';

const LAST_KEY = 'breakpatch.updates.lastChecked';
function readLast(): number | null { try { const v = localStorage.getItem(LAST_KEY); return v ? Number(v) : null; } catch { return null; } }
function writeLast(t: number) { try { localStorage.setItem(LAST_KEY, String(t)); } catch { /* ignore */ } }
function lastLine(t: number | null): string {
  if (!t) return 'Updates also install on restart.';
  const when = daysAgo(t) === 0 ? `today, ${clock(t)}` : formatDateTime(t).replace(/^Yesterday/, 'yesterday');
  return `Last checked ${when}. Updates also install on restart.`;
}

export function AboutSection() {
  const info = useSystemInfo();
  const ws = useSession(s => s.workspace);
  const local = useSession(s => s.local);
  const online = useSession(s => s.online);
  const updateReady = useSystem(s => s.updateReady);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [last, setLast] = useState(readLast);
  const version = appVersion();
  const editionName = editionLabel(edition.name);

  const check = async () => {
    setChecking(true); setResult(null);
    const r = await checkForUpdates();
    const now = Date.now(); writeLast(now); setLast(now);
    setResult(r); setChecking(false);
  };

  const ready = updateReady ?? (result?.state === 'ready' ? result.version : null);
  const browser = info ? (info.browser.version ? `${info.browser.version}, pinned` : 'Not installed') : '…';
  const ai = info ? (info.model.installed ? `${modelSize(info)}, same on every Mac` : 'Not downloaded') : '…';
  const mac = info ? `Apple silicon · ${info.memoryGb} GB · ${info.os}` : '…';
  const library = online ? 'Connected' : 'Offline · changes wait until you’re back';

  const details = () => [
    `Breakpatch ${version}${isTauri() ? '' : ' (browser preview)'}`,
    `Edition ${editionName}${info && info.edition !== edition.name ? ` (engine ${info.edition ? editionLabel(info.edition) : 'unknown'})` : ''}`,
    local ? `Tests folder ${local.path}` : `Workspace ${ws?.config.projectId ?? '—'} / ${ws?.database ?? '—'}`,
    `Test browser ${info?.browser.version ?? 'not installed'}`,
    `AI assistant ${info?.model.repo ?? '—'}@${info?.model.revision ?? '—'}${info?.model.installed ? '' : ' (not downloaded)'}`,
    `Engine ${info?.engineVersion ?? '—'}`,
    `This Mac ${info?.chip ?? 'Apple silicon'} · ${info?.memoryGb ?? '?'} GB · ${info?.os ?? 'macOS'}`,
  ].join('\n');

  return (
    <Section title="About">
      <div className="set-card">
        <div className="set-appicon"><EarMark size={26} /></div>
        <div className="grow col" style={{ gap: 3 }}>
          <Wordmark size={19} ear={false} />
          <div className="set-card-sub">Version {version} · {editionName}{edition.name === 'community' ? ' · Open source' : ''}</div>
        </div>
        {checking ? <StatusPill status="running">Checking…</StatusPill>
          : ready ? <span className="pill pill-accent"><Icon name="system_update" />{ready} is ready</span>
          : result?.state === 'failed' ? <StatusPill status="failed">Couldn't check</StatusPill>
          : <StatusPill status="passed">Up to date</StatusPill>}
      </div>

      <div className="row" style={{ gap: 12 }}>
        {ready
          ? <Button kind="primary" icon="restart_alt" onClick={() => void restartToUpdate()}>Restart to update</Button>
          : <Button icon="refresh" busy={checking} onClick={() => void check()}>{checking ? 'Checking…' : 'Check for updates'}</Button>}
        <span className="set-note" role="status">
          {result?.state === 'failed' ? result.reason
            : result?.state === 'upToDate' ? `You have the latest version. ${lastLine(last)}`
            : ready ? `Breakpatch ${ready} is downloaded. Runs in progress finish first.`
            : lastLine(last)}
        </span>
      </div>

      <EditionMismatch app={edition.name} engine={info?.edition} />

      <div className="set-facts two">
        <Fact label="Test browser" value={browser} />
        <Fact label="AI assistant" value={ai} />
        {local ? <Fact label="Tests folder" value={baseName(local.path)} /> : <Fact label="Shared library" value={library} />}
        <Fact label="This Mac" value={mac} />
      </div>

      <div className="set-flush"><CopyButton text={details} label="Copy details for a developer" copiedLabel="Details copied" kind="link" /></div>

      <p className="set-mora"><EarMark size={12} />Here to find what breaks.</p>
    </Section>
  );
}

import { useState } from 'react';
import { Button, CopyButton, EarMark, Icon, StatusPill, Wordmark } from '../../../components/ui';
import { appVersion, isTauri, openExternal } from '../../../platform';
import { checkForUpdates, restartToUpdate, type CheckResult } from '../../../lib/updates';
import { RELEASES_URL, useUpdateSource } from '../../../lib/useUpdateSource';
import { useSession } from '../../../state/session';
import { useSystem } from '../../../state/system';
import { clock, daysAgo, formatDateTime } from '../../../components/common/format';
import { Fact, Section } from './common';
import { baseName } from '../../../data/local/storage';
import { modelSize, useSystemInfo } from './AiSection';
import { edition } from '../../../edition';
import { EditionMismatch, editionLabel } from './edition';
import { Computer, isMac, osFormat, osText, ThisComputer } from '../../../lib/osWords';

function lastLine(t: number | null): string {
  if (!t) return 'Breakpatch also checks when it opens and every hour.';
  const when = daysAgo(t) === 0 ? `today, ${clock(t)}` : formatDateTime(t).replace(/^Yesterday/, 'yesterday');
  return `Last checked ${when}. Breakpatch also checks when it opens and every hour.`;
}

export function AboutSection() {
  const info = useSystemInfo();
  const ws = useSession(s => s.workspace);
  const local = useSession(s => s.local);
  const online = useSession(s => s.online);
  const updateReady = useSystem(s => s.updateReady);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const last = useSystem(s => s.updateCheckedAt);       // an automatic check ending meanwhile too
  // A .deb is updated by its package manager: no checks here, and About says how instead.
  const fromPackage = useUpdateSource() === 'package';
  const version = appVersion();
  const editionName = editionLabel(edition.name);

  const check = async () => {
    setChecking(true); setResult(null);
    const r = await checkForUpdates();     // joins an automatic check going on
    setResult(r); setChecking(false);
  };

  const ready = updateReady ?? (result?.state === 'ready' ? result.version : null);
  // Plain words here; the exact versions are in Copy details (DESK-16).
  const browser = info ? (info.browser.version ? osText('Installed, the same version on every Mac') : 'Not installed') : '…';
  const ai = info ? (info.model.installed ? osFormat`${modelSize(info)}, same on every Mac` : 'Not downloaded') : '…';
  const mac = info ? `${isMac() ? 'Apple silicon' : info.chip} · ${info.memoryGb} GB · ${info.os}` : '…';
  const library = online ? 'Online' : 'Offline · changes wait until you’re back';

  const details = () => [
    `Breakpatch ${version}${isTauri() ? '' : ' (browser preview)'}`,
    `Edition ${editionName}${info && info.edition !== edition.name ? ` (engine ${info.edition ? editionLabel(info.edition) : 'unknown'})` : ''}`,
    local ? `Tests folder ${local.path}` : `Workspace ${ws?.config.projectId ?? '—'} / ${ws?.database ?? '—'}`,
    `Test browser ${info?.browser.version ?? 'not installed'}`,
    `AI assistant ${info?.model.repo ?? '—'}@${info?.model.revision ?? '—'}${info?.model.installed ? '' : ' (not downloaded)'}`,
    `Engine ${info?.engineVersion ?? '—'}`,
    isMac() ? `This Mac ${info?.chip ?? 'Apple silicon'} · ${info?.memoryGb ?? '?'} GB · ${info?.os ?? 'macOS'}`
      : `${Computer()} ${info?.chip ?? '?'} · ${info?.memoryGb ?? '?'} GB · ${info?.os ?? '?'}`,
  ].join('\n');

  return (
    <Section title="About">
      <div className="set-card">
        <div className="set-appicon"><EarMark size={26} /></div>
        <div className="grow col" style={{ gap: 3 }}>
          <Wordmark size={19} ear={false} />
          <div className="set-card-sub">Version {version} · {editionName}{edition.name === 'community' ? ' · Open source' : ''}</div>
        </div>
        {fromPackage ? null
          : checking ? <StatusPill status="running">Checking…</StatusPill>
          : ready ? <span className="pill pill-accent"><Icon name="system_update" />{ready} is ready</span>
          : result?.state === 'failed' ? <StatusPill status="failed">Couldn't check</StatusPill>
          : <StatusPill status="passed">Up to date</StatusPill>}
      </div>

      {fromPackage ? (
        <div className="row" style={{ gap: 12 }}>
          <Button iconAfter="open_in_new" onClick={() => void openExternal(RELEASES_URL).catch(() => undefined)}>GitHub Releases</Button>
          <span className="set-note" role="status">
            Breakpatch was installed from its .deb package, so it doesn't update itself. To update, download the new .deb from GitHub Releases and install it with sudo apt install ./&lt;file&gt;.deb.
          </span>
        </div>
      ) : (
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
      )}

      <EditionMismatch app={edition.name} engine={info?.edition} />

      <div className="set-facts two">
        <Fact label="Test browser" value={browser} />
        <Fact label="AI assistant" value={ai} />
        {local ? <Fact label="Tests folder" value={baseName(local.path)} /> : <Fact label="Team workspace" value={library} />}
        <Fact label={ThisComputer()} value={mac} />
      </div>

      <div className="set-flush"><CopyButton text={details} label="Copy details for a developer" copiedLabel="Details copied" kind="link" /></div>

      <p className="set-mora"><EarMark size={12} />Here to find what breaks.</p>
    </Section>
  );
}

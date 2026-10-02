import { hasFeature } from '../../../edition';
import { useEffect, useState } from 'react';
import { Button, Disc, Icon, Skeleton, StatusPill, useToast } from '../../../components/ui';
import { getEngine, MODELS, type SystemInfo } from '../../../engine';
import { useSession } from '../../../state/session';
import { Confirm, Fact, Section, gb } from './common';

export function useSystemInfo(): SystemInfo | null {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  useEffect(() => {
    let live = true;
    getEngine().systemInfo().then(i => { if (live) setInfo(i); }, () => {});
    return () => { live = false; };
  }, []);
  return info;
}

export function modelSize(info: SystemInfo | null): 'Standard' | 'Larger' {
  return info?.model.repo === MODELS.larger.repo ? 'Larger' : 'Standard';
}

export function AiSection() {
  // Fixing moved buttons is Team only (DESK-08).
  const fixing = hasFeature('autoFix');
  // The Larger assistant is only offered on the local runner (Team, Settings → Local runner).
  const runner = hasFeature('runner');
  const info = useSystemInfo();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const installed = info?.model.installed ?? true;
  const size = gb(info?.model.sizeBytes);

  const remove = async () => {
    try { await getEngine().removeModel(); useSession.getState().setSetupDone(false); }
    catch { toast("Couldn't remove the AI assistant. Try again.", { error: true }); }
  };

  return (
    <Section title="AI assistant">
      <div className="set-card col">
        <div className="row" style={{ gap: 12 }}>
          <Disc icon="auto_awesome" size={44} color="var(--accent)" />
          <div className="grow col" style={{ gap: 2 }}>
            <div style={{ fontSize: 16, fontWeight: 600 }}>AI assistant</div>
            <div className="set-card-sub sm">{fixing ? 'Names each step you record, and fixes moved buttons during runs.' : 'Names each step you record.'}</div>
          </div>
          {!info ? <Skeleton w={70} h={26} r={13} /> : installed ? <StatusPill status="passed">Ready</StatusPill> : <StatusPill status="failed">Not downloaded</StatusPill>}
        </div>
        <div className="set-facts">
          <Fact label="Size" value={info ? modelSize(info) : <Skeleton w={70} />} />
          <Fact label="On disk" value={info ? (installed ? size : 'Not downloaded') : <Skeleton w={60} />} />
          <Fact label="This Mac" value={info ? `${info.memoryGb} GB memory` : <Skeleton w={100} />} />
        </div>
      </div>

      <div className="set-info">
        <Icon name="info" />
        <div className="grow">The built-in assistant works well for almost every app.{runner ? ' A local runner Mac with 32 GB of memory or more can also download a larger one, in Settings → Local runner.' : ''} Bringing your own model isn't available yet.</div>
      </div>

      <div className="col" style={{ gap: 8 }}>
        <div><Button kind="danger" icon="delete" disabled={!installed} onClick={() => setConfirm(true)}>Remove from this Mac</Button></div>
        <p className="set-note">Frees {size}. You won't be able to record tests{fixing ? ' or fix moved buttons' : ''} until you download it again.</p>
      </div>

      <Confirm open={confirm} onClose={() => setConfirm(false)} icon="delete"
        title="Remove the AI assistant?" confirm="Remove"
        text={<>Frees {size} on this Mac. Recording is blocked until you download it again, so setup opens straight after.</>}
        onConfirm={remove} />
    </Section>
  );
}

// Settings → Tests folder (Community): where the tests are saved, and switching to another folder.
import { useEffect, useState } from 'react';
import { Button, Dialog, Icon, useToast } from '../../../components/ui';
import { plural } from '../../../components/common/format';
import { useBackend } from '../../../data/hooks';
import { LocalBackend } from '../../../data/local/localBackend';
import { baseName } from '../../../data/local/storage';
import { edition } from '../../../edition';
import { isTauri, revealInFinder } from '../../../platform';
import { useSession } from '../../../state/session';
import { useChooseFolder } from '../../welcome/useChooseFolder';
import { Section } from './common';
import { showInFileManager } from '../../../lib/osWords';

function useCounts() {
  const backend = useBackend();
  const [c, setC] = useState<{ apps: number; tests: number } | null>(null);
  useEffect(() => (backend instanceof LocalBackend ? backend.counts(setC) : undefined), [backend]);
  return c;
}

export function FolderSection() {
  const local = useSession(s => s.local);
  const counts = useCounts();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const { choose, busy, error, dialog } = useChooseFolder(p => toast(`Now using ${baseName(p)}`));

  if (!local) return null;
  return (
    <Section title="Tests folder">
      <div className="set-card col">
        <div className="row" style={{ gap: 14 }}>
          <span className="set-folder-disc" aria-hidden><Icon name="folder" /></span>
          <div className="grow col" style={{ gap: 3, minWidth: 0 }}>
            <div className="set-folder-path" title={local.path}>{local.path}</div>
            <div className="set-card-sub sm">{counts ? `${plural(counts.apps, 'app')} · ${plural(counts.tests, 'test')}` : ' '}</div>
          </div>
        </div>
        <div className="row" style={{ gap: 10 }}>
          {isTauri() && <Button icon="folder_open" onClick={() => void revealInFinder(local.path)}>{showInFileManager()}</Button>}
          <Button icon="drive_file_move" busy={busy} onClick={() => setAsking(true)}>Change folder</Button>
        </div>
      </div>

      {error && <div className="set-info set-folder-error" role="alert"><Icon name="error" />{error}</div>}

      <div className="set-info"><Icon name="history" />Only the latest version of each test is kept. Use Git to keep history.</div>
      {edition.name === 'community' && <p className="set-note">Get version history and a shared workspace with Team.</p>}

      <Dialog open={asking} onClose={() => setAsking(false)} title="Change the tests folder?" icon="drive_file_move" width={460}
        actions={<>
          <Button kind="ghost" onClick={() => setAsking(false)}>Cancel</Button>
          <Button kind="primary" onClick={() => { setAsking(false); void choose(); }}>Choose a folder</Button>
        </>}>
        <p className="set-dlg-text">Breakpatch opens the folder you choose next. {baseName(local.path)} stays as it is, with all its tests.</p>
      </Dialog>
      {dialog}
    </Section>
  );
}

// First launch in Community (App.tsx gate): "Start on this Mac." Pick the folder the tests are
// saved in; the gate then runs Setup and opens Home. The edition can add a choice below
// (edition.slots.welcomeExtra; Team: "Connect a workspace").
import { useState } from 'react';
import { Button, Icon, Menu } from '../../components/ui';
import { GateSplit } from '../../components/shell/GateWindow';
import { edition } from '../../edition';
import { recentFolders } from '../../lib/recentFolders';
import { isTauri } from '../../platform';
import { useSession } from '../../state/session';
import { shortPath, useChooseFolder } from './useChooseFolder';
import './welcome.css';

export default function WelcomeScreen() {
  const Extra = edition.slots.welcomeExtra;
  const launchError = useSession(s => s.localError);
  const { choose, open, busy, error, dialog } = useChooseFolder();
  const [menu, setMenu] = useState(false);
  const recents = recentFolders();
  const problem = error ?? launchError;

  return (
    <GateSplit width={440}>
      <div className="gi-head">
        <h1 className="gi-title">Start on this Mac.</h1>
        <p className="gi-lede">Your tests are saved as files in a folder you pick. Put it in your project's repo to keep them with your code.</p>
      </div>

      {problem && (
        <div className="gi-alert failed" role="alert">
          <Icon name="error" />
          <div className="wl-alert-copy">
            <div className="gi-alert-title">Couldn't open this folder</div>
            <div className="gi-alert-body">{problem}</div>
          </div>
        </div>
      )}

      <div className="wl-choose">
        <div className="gi-actions">
          <Button kind="primary" size="lg" icon="folder_open" busy={busy} onClick={() => void choose()}>Choose a folder</Button>
        </div>
        {!isTauri() && <div className="gi-foot-note">Preview: files are kept in memory.</div>}
        {recents.length > 0 && (
          <div className="wl-recent">
            <button type="button" className="wl-link" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(v => !v)}>
              <Icon name="history" />Open a recent folder
            </button>
            <Menu open={menu} onClose={() => setMenu(false)} label="Recent folders" width={400} style={{ left: 0, top: 'calc(100% + 6px)' }}
              items={recents.map(p => ({ label: shortPath(p), icon: 'folder', onSelect: () => void open(p) }))} />
          </div>
        )}
      </div>

      {Extra && <div className="wl-extra"><Extra /></div>}
      {dialog}
    </GateSplit>
  );
}

// The title bar's workspace switcher (state/connections.ts): the personal space (a tests folder
// on this Mac) and the Team workspaces this Mac has connected, like Slack's. It shows only on the
// top-level screens, where no test is running or recording, and only when there is somewhere else
// to go (or the edition adds a way to connect one).
//
// Switching goes home, closes the browser the recorder used, closes the workspace open without
// signing out and opens the other one. The edition can lock it (Team: on the local runner's Mac,
// which serves one workspace).
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Menu, useToast, type MenuEntry } from '../ui';
import { edition } from '../../edition';
import { canOpen, useSession } from '../../state/session';
import { canOpenKind, sortedConnections, useConnections, type Connection } from '../../state/connections';

const useLock = edition.slots.useSwitchLock ?? (() => null);

/** The connections this edition can open. */
function openable(list: Connection[]): Connection[] {
  return list.filter(c => canOpenKind(c) && (c.kind === 'local' || canOpen(c.team!.workspace)));
}

export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const toast = useToast();
  const { list, activeId } = useConnections();
  const workspace = useSession(s => s.workspace);
  const lock = useLock();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const all = sortedConnections(openable(list));
  const active = all.find(c => c.id === activeId);
  const extra = edition.slots.switcherActions?.({ close: () => setOpen(false), navigate: p => navigate(p), workspace, connections: list }) ?? [];
  if (!active || (all.length < 2 && !extra.length)) return null;

  const go = async (c: Connection) => {
    if (c.id === activeId) return;
    setBusy(true);
    navigate('/');
    try {
      const { getEngine } = await import('../../engine');
      await getEngine().closeBrowser().catch(() => {});
      await useSession.getState().switchTo(c);
    } catch (e) {
      toast(`Couldn't open ${c.name}. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      setBusy(false);
    }
  };

  const items: MenuEntry[] = [
    ...all.map(c => ({ label: labelOf(c), icon: iconOf(c), checked: c.id === activeId, disabled: busy || (!!lock && c.id !== activeId), onSelect: () => void go(c) })),
    ...(lock ? [{ group: lock } as const] : []),
    ...(extra.length ? ['sep' as const, ...extra] : []),
  ];
  return (
    <div className="ws-switch">
      <button type="button" className="ws-switch-btn" aria-haspopup="menu" aria-expanded={open} disabled={busy}
        aria-label={`Workspace: ${labelOf(active)}. Switch workspace`} onClick={() => setOpen(o => !o)}>
        <Icon name={iconOf(active)} size={18} />
        <span className="ws-switch-name">{labelOf(active)}</span>
        <Icon name="expand_more" size={18} />
      </button>
      <Menu open={open} onClose={() => setOpen(false)} label="Switch workspace" width={280} style={{ top: 'calc(100% + 6px)', left: 0 }} items={items} />
    </div>
  );
}

function labelOf(c: Connection): string { return c.personal ? `Personal: ${c.name}` : c.kind === 'demo' ? 'Demo workspace' : c.name; }
function iconOf(c: Connection): string { return c.personal ? 'folder' : c.kind === 'demo' ? 'science' : c.kind === 'hosted' ? 'cloud' : 'hub'; }

// The title bar's workspace switcher (state/connections.ts): the personal space (a tests folder
// on this Mac) and the Team workspaces this Mac has connected, like Slack's. It shows only on the
// top-level screens, where no test is running or recording, and only when there is somewhere else
// to go (or the edition adds a way to connect one).
//
// Switching goes home, closes the browser the recorder used, closes the workspace open without
// signing out and opens the other one. The edition can lock it (Team: on the local runner's Mac,
// which serves one workspace), add entries after the list (Team: Add a workspace, Open a tests
// folder, Manage workspaces) with what they open beside it, and turn on ⌘1 to ⌘9 for the first
// nine entries, in the menu's order (Team).
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon, Menu, useToast, type MenuEntry } from '../ui';
import { edition } from '../../edition';
import { useSession } from '../../state/session';
import { useConnections, type Connection } from '../../state/connections';
import { ariaShortcut, otherCommandKeyDown, shortcut, shortcutKeyDown } from '../../lib/osWords';
import { iconOf, labelOf, openConnection, sameLabel, switcherList, whereOf } from './switcherList';

const useLock = edition.slots.useSwitchLock ?? (() => null);
const Extra = edition.slots.switcherExtra;
const SHORTCUTS = !!edition.slots.switcherShortcuts;

/** 1 to 9 for ⌘1 to ⌘9: the key's place on the keyboard first, so other layouts (⌘& on a French one) work too. */
function digitOf(e: KeyboardEvent): number | null {
  const code = e.code ?? '';
  const m = /^Digit([1-9])$/.exec(code) ?? (code.startsWith('Digit') ? null : /^([1-9])$/.exec(e.key));
  return m ? Number(m[1]) : null;
}

export function WorkspaceSwitcher() {
  const navigate = useNavigate();
  const toast = useToast();
  const { list, activeId } = useConnections();
  const workspace = useSession(s => s.workspace);
  const lock = useLock();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const all = switcherList(list);
  const active = all.find(c => c.id === activeId);

  const go = async (c: Connection) => {
    if (c.id === activeId) return;
    setOpen(false);
    setBusy(true);
    try {
      await openConnection(c, navigate);
    } catch (e) {
      toast(`Couldn't open ${c.name}. ${e instanceof Error ? e.message : ''}`.trim());
    } finally {
      setBusy(false);
    }
  };

  // ⌘1 to ⌘9 (Team): the entries in the menu's order, wherever the switcher shows. Not while a
  // dialog is open; while switching is locked, it says why.
  const now = useRef({ all, go, lock, busy, activeId });
  useEffect(() => { now.current = { all, go, lock, busy, activeId }; });
  useEffect(() => {
    if (!SHORTCUTS) return;
    const onKey = (e: KeyboardEvent) => {
      if (!shortcutKeyDown(e) || otherCommandKeyDown(e) || e.altKey || e.shiftKey || e.defaultPrevented) return;
      const n = digitOf(e);
      if (!n || document.querySelector('[aria-modal="true"]')) return;
      const { all: entries, go: switchTo, lock: locked, busy: switching, activeId: current } = now.current;
      const c = entries[n - 1];
      if (!c) return;
      e.preventDefault();
      if (switching || c.id === current) return;
      if (locked) { toast(locked); return; }
      void switchTo(c);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast]);

  const extra = edition.slots.switcherActions?.({ close: () => setOpen(false), navigate: p => navigate(p), workspace, connections: list, locked: !!lock }) ?? [];
  if (!active || (all.length < 2 && !extra.length)) return null;

  const items: MenuEntry[] = [
    ...all.map((c, i) => ({
      label: labelOf(c), icon: iconOf(c), checked: c.id === activeId, disabled: busy || (!!lock && c.id !== activeId), onSelect: () => void go(c),
      ...(sameLabel(c, all) ? { detail: whereOf(c) } : {}),
      ...(SHORTCUTS && i < 9 ? { shortcut: shortcut(String(i + 1)), keyshortcuts: ariaShortcut(String(i + 1)) } : {}),
    })),
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
      <Menu open={open} onClose={() => setOpen(false)} label="Switch workspace" width={SHORTCUTS ? 300 : 280} style={{ top: 'calc(100% + 6px)', left: 0 }} items={items} />
      {Extra && <Extra />}
    </div>
  );
}

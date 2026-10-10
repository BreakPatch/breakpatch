// The action list (260 px, pops from the action button, grouped). Full keyboard navigation.
import { useEffect, useRef } from 'react';
import type { ActionKind } from '../../data/types';
import { Icon } from '../../components/ui';
import { usePresence } from '../../components/ui/presence';
import { DESCRIBE_STEPS, menuGroups, type MenuAction } from './actions';
import { edition } from '../../edition';
import { useFeatureStore } from '../../edition/features';

export function ActionMenu({ open, current, allowGroups, touch, onPick, onClose }: {
  open: boolean; current: ActionKind; allowGroups: boolean; onPick: (a: MenuAction) => void; onClose: () => void;
  /** A phone or tablet test: touch names, and no Right click or Hover (the foot says why). */
  touch?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open);
  // The edition's actions, while their feature is on (Team: Wait for an email, `email`).
  const features = useFeatureStore(s => s.features);
  const extra = (edition.slots.recorderActions ?? []).filter(a => !a.feature || features[a.feature]);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    (el?.querySelector<HTMLElement>('[aria-checked="true"]') ?? el?.querySelector<HTMLElement>('[role^="menuitem"]'))?.focus();
    const onDown = (e: MouseEvent) => { if (el && !el.contains(e.target as Node) && !(e.target as HTMLElement).closest('.rec-action-btn')) onClose(); };
    const onKey = (e: KeyboardEvent) => {
      if (!el) return;
      const list = [...el.querySelectorAll<HTMLElement>('[role^="menuitem"]')];
      const i = list.indexOf(document.activeElement as HTMLElement);
      const go = (k: number) => { e.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
      else if (e.key === 'ArrowDown') go(i + 1);
      else if (e.key === 'ArrowUp') go(i - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(list.length - 1);
      else if (e.key === 'Tab') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open, onClose]);
  if (!mounted) return null;
  return (
    <div ref={ref} className={'menu rec-menu' + (closing ? ' closing' : '')} role="menu" aria-label="Actions" aria-hidden={closing || undefined} inert={closing || undefined}>
      <div className="rec-menu-scroll">
        {menuGroups({ allowGroups, touch, extra }).map(g => (
          <div key={g.title} role="group" aria-label={g.title}>
            <div className="menu-group">{g.title}</div>
            {g.items.map(a => {
              const on = !a.nav && a.kind === current;
              return (
                <button key={a.id} type="button" role="menuitemradio" aria-checked={on} className={'menu-item' + (on ? ' on' : '')} onClick={() => { if (open) onPick(a); }}>
                  <Icon name={a.icon} size={18} /><span className="grow">{a.name}</span>
                  {on && <Icon name="check" size={18} className="rec-menu-check" />}
                  {a.kind === 'group' && <Icon name="chevron_right" size={18} />}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {touch && <div className="rec-menu-foot">Right click and Hover need a mouse, so phone and tablet tests don't have them.</div>}
      <div className="rec-menu-foot">{DESCRIBE_STEPS ? "The chosen action is used for your next click on the page, and for a message that doesn't say what to do." : 'The chosen action is used for your next click on the page.'}</div>
    </div>
  );
}

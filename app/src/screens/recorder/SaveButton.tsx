// Save (primary) with the optional "What changed?" note in a small popover. Without version
// history (Community) saving overwrites, so it's a plain Save button with no note.
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui';
import { hasFeature } from '../../edition';

export function SaveButton({ label = 'Save', nextVersion, disabled, busy, onSave }: {
  label?: string; nextVersion: number; disabled?: boolean; busy?: boolean; onSave: (note: string) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const focusBtn = () => wrap.current?.querySelector<HTMLButtonElement>('button')?.focus();
  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector('input')?.focus();
    const onDown = (e: MouseEvent) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); focusBtn(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey, true); };
  }, [open]);
  const save = async () => { setOpen(false); await onSave(note.trim()); setNote(''); };
  if (!hasFeature('versions')) {
    return <div className="rec-save" ref={wrap}><Button kind="primary" disabled={disabled} busy={busy} onClick={() => void onSave('')}>{label}</Button></div>;
  }
  return (
    <div className="rec-save" ref={wrap}>
      <Button kind="primary" disabled={disabled} busy={busy} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(o => !o)}>{label}</Button>
      {open && (
        <div ref={ref} className="rec-save-pop" role="dialog" aria-label="Save a new version">
          <label className="field-label" htmlFor="rec-note">What changed?</label>
          <input id="rec-note" className="input" value={note} placeholder="For example: Updated the Done button" maxLength={140}
            onChange={e => setNote(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          <div className="field-hint">Shown in version history. Optional.</div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <Button kind="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button kind="primary" onClick={() => void save()}>Save as version {nextVersion}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

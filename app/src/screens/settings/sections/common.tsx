// Small pieces shared by the settings sections.
import { useState, type ReactNode } from 'react';
import { Button, Dialog } from '../../../components/ui';

export function Section({ title, variant, children }: { title: ReactNode; variant?: 'wide' | 'w860' | 'gap18'; children: ReactNode }) {
  return (
    <section className={`set-content${variant ? ' ' + variant : ''}`} aria-labelledby="set-title">
      {typeof title === 'string' ? <h2 className="set-title" id="set-title">{title}</h2> : title}
      {children}
    </section>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return <div className="set-fact"><div>{label}</div><div>{value}</div></div>;
}

/** Confirm dialog for destructive actions. The confirm button shows a spinner while `onConfirm` runs. */
export function Confirm({ open, onClose, title, text, confirm, onConfirm, icon = 'warning' }: {
  open: boolean; onClose: () => void; title: string; text: ReactNode; confirm: string; onConfirm: () => Promise<void> | void; icon?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} title={title} icon={icon} iconColor="var(--failed)"
      actions={<>
        <Button kind="ghost" onClick={onClose}>Cancel</Button>
        <Button kind="danger" busy={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } finally { setBusy(false); } }}>{confirm}</Button>
      </>}>
      <p className="set-dlg-text">{text}</p>
    </Dialog>
  );
}

/** "1.5 GB" */
export function gb(bytes: number | undefined): string {
  if (!bytes) return '—';
  return `${(bytes / 1e9).toFixed(1).replace(/\.0$/, '')} GB`;
}

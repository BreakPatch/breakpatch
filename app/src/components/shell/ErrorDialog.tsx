// Error dialog (design "System States"): red icon, plain reason, collapsible details (mono),
// Try again · Copy details · Close.
import { useId, useState } from 'react';
import { Button, CopyButton, Dialog, Icon } from '../ui';
import { useSystem } from '../../state/system';
import './systemStates.css';

export function ErrorDialog() {
  const { error, showError } = useSystem();
  const [open, setOpen] = useState(false);
  const tid = useId();
  const close = () => { showError(null); setOpen(false); };
  if (!error) return null;
  return (
    <Dialog open onClose={close} labelledBy={tid} width={574}>
      <div className="sys-err">
        <div className="sys-err-head">
          <Icon name="error" />
          <div className="col" style={{ gap: 6 }}>
            <h2 className="sys-err-title" id={tid}>{error.title}</h2>
            <p className="sys-err-reason">{error.reason}</p>
          </div>
        </div>
        {error.details && (
          <div className="col" style={{ gap: 8 }}>
            <button className="sys-err-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
              <Icon name={open ? 'expand_less' : 'expand_more'} />Details
            </button>
            {open && <pre className="sys-err-details">{error.details}</pre>}
          </div>
        )}
        <div className="sys-err-actions">
          {error.retry && <Button kind="primary" icon="replay" onClick={() => { const r = error.retry!; close(); r(); }}>Try again</Button>}
          {error.details && <CopyButton text={error.details} label="Copy details" copiedLabel="Details copied" size="md" />}
          <button className="sys-err-close" onClick={close}>Close</button>
        </div>
      </div>
    </Dialog>
  );
}

// Export (issue #43): the run report (or a suite run's) as a web page anyone can open without
// Breakpatch, as a PDF through the print dialog, or as JUnit XML for CI dashboards. Screenshots
// can show personal data, so the dialog says so and lets people leave them out.
import { useState } from 'react';
import { Button, Dialog, Icon, Switch, useToast } from '../../components/ui';
import { exportReport, type ExportFormat } from '../../lib/report/collect';
import type { ReportInput } from '../../lib/report';
import './export.css';

const FORMATS: { value: ExportFormat; icon: string; title: string; text: string }[] = [
  { value: 'html', icon: 'language', title: 'Web page (HTML)', text: 'One file that opens in any browser, offline. Attach it to a ticket or an email, or drop it in a chat.' },
  { value: 'pdf', icon: 'description', title: 'PDF', text: 'Opens the print dialog. Choose PDF → Save as PDF.' },
  { value: 'junit', icon: 'code', title: 'JUnit XML', text: 'For CI dashboards: GitHub, GitLab and Jenkins read it. No screenshots.' },
];

export function ExportDialog({ open, onClose, what, load }: {
  open: boolean; onClose: () => void;
  /** "this run", "this suite run" */
  what: string;
  /** The report's input, with or without the screenshots. */
  load: (screenshots: boolean) => Promise<ReportInput>;
}) {
  const toast = useToast();
  const [format, setFormat] = useState<ExportFormat>('html');
  const [shots, setShots] = useState(true);
  const [busy, setBusy] = useState(false);
  const withShots = format !== 'junit';

  const go = async () => {
    setBusy(true);
    try {
      const input = await load(withShots && shots);
      const done = await exportReport(input, format);
      if (done) {
        if (format !== 'pdf') toast(format === 'junit' ? 'Saved the JUnit XML.' : 'Saved the report.');
        onClose();
      }
    } catch (e) {
      toast(`Couldn't export ${what}: ${e instanceof Error ? e.message : String(e)}`, { error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={`Export ${what}`} width={540}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" icon="download" busy={busy} onClick={() => void go()}>Export</Button>
      </>}>
      <div className="rpx-body">
        <div className="rpx-formats" role="radiogroup" aria-label="Format">
          {FORMATS.map(f => (
            <label key={f.value} className={`rpx-format${format === f.value ? ' on' : ''}`}>
              <input type="radio" name="rpx-format" value={f.value} checked={format === f.value} onChange={() => setFormat(f.value)} />
              <Icon name={f.icon} size={22} />
              <span className="grow col"><span className="rpx-format-t">{f.title}</span><span className="rpx-format-d">{f.text}</span></span>
            </label>
          ))}
        </div>
        {withShots && (
          <div className="rpx-shots">
            <label className="rpx-shots-row">
              <span className="grow col">
                <span className="rpx-format-t">Include screenshots</span>
                <span className="rpx-format-d">Full size for the step that failed, small for the others.</span>
              </span>
              <Switch checked={shots} onChange={setShots} label="Include screenshots" />
            </label>
            <div className="rpx-note" role="note"><Icon name="privacy" size={18} />Screenshots can show personal data, like names, email addresses or account details on the page. Leave them out if the report goes to people who shouldn't see that.</div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

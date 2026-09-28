// A click on the page opened its file picker. No system dialog can show over the test browser,
// so this asks which file the step uploads: a sample, one of the user's own files (the tests
// folder's files/), or a file from this Mac, copied into files/ so the test keeps working.
import { useEffect, useState } from 'react';
import type { FileChoice, FileChooserEvent } from '../../engine';
import { Button, Dialog, Icon } from '../../components/ui';
import { addOwnFile, accepts, ownFiles, samplesFor } from '../../lib/testFiles';
import { join } from '../../data/local/storage';

export function FileChooserDialog({ ask, dir, onChoose }: {
  ask: FileChooserEvent | null;
  /** <tests folder>/files, or undefined (no tests folder: samples only). */
  dir: string | undefined;
  onChoose: (c: FileChoice) => void;
}) {
  const [mine, setMine] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (ask) void ownFiles(dir).then(setMine); }, [ask, dir]);
  if (!ask) return null;
  const fromMac = async () => {
    if (!dir) return;
    setError(null);
    try {
      const { filesFs } = await import('../../lib/testFiles');
      const src = await filesFs().pick(ask.accept);
      if (!src) return;
      onChoose(await addOwnFile(dir, src));
    } catch (e) {
      setError(e instanceof Error ? `Couldn't copy that file: ${e.message}` : "Couldn't copy that file.");
    }
  };
  const sorted = [...mine.filter(n => accepts(ask.accept, n)), ...mine.filter(n => !accepts(ask.accept, n))];
  return (
    <Dialog open onClose={() => onChoose({ cancel: true })} title="This button opens a file picker" icon="upload_file"
      sub="Choose the file to use. The step then uploads the same file every time the test runs."
      actions={<Button onClick={() => onChoose({ cancel: true })}>Cancel, just click</Button>}>
      <div className="fc-list" role="list" aria-label="Sample files">
        <div className="fc-head">Sample files</div>
        {samplesFor(ask.accept).map(s => (
          <button key={s.kind} type="button" role="listitem" className={'fc-item' + (s.fits ? '' : ' faint')} onClick={() => onChoose({ sample: s.kind })}>
            <Icon name="draft" size={18} />{s.name}{!s.fits && <span className="fc-note">The page may not take this type</span>}
          </button>
        ))}
        {dir && <>
          <div className="fc-head">Your files</div>
          {sorted.length === 0 && <div className="fc-empty">None yet. Files you choose from this Mac are kept in the tests folder, in files.</div>}
          {sorted.map(n => (
            <button key={n} type="button" role="listitem" className="fc-item" onClick={() => onChoose({ file: `files/${n}`, path: join(dir, n) })}>
              <Icon name="description" size={18} />{n}
            </button>
          ))}
          <button type="button" className="fc-item fc-mac" onClick={() => void fromMac()}><Icon name="folder_open" size={18} />Choose from this Mac…</button>
        </>}
        {error && <div className="fc-error" role="alert">{error}</div>}
      </div>
    </Dialog>
  );
}

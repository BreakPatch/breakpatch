// Test details: a test's name, description and start address after it's made. Opened from the
// test's ⋯ menu on the Tests tab and from the recorder's title bar. The same checks as New test.
import { useEffect, useState } from 'react';
import { Button, Dialog, Icon, TextInput, useToast } from '../../components/ui';
import { useBackend } from '../../data/hooks';
import type { Test } from '../../data/types';
import { useFeature } from '../../edition';
import { isHttpAddress } from './tryCall';

export function TestDetailsDialog({ open, test, onClose }: { open: boolean; test: Test; onClose: () => void }) {
  const backend = useBackend();
  const toast = useToast();
  const history = useFeature('versions');
  const [name, setName] = useState(test.name);
  const [description, setDescription] = useState(test.description ?? '');
  const [startUrl, setStartUrl] = useState(test.startUrl);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  // Fresh from the test each time it opens.
  useEffect(() => {
    if (!open) return;
    setName(test.name); setDescription(test.description ?? ''); setStartUrl(test.startUrl);
    setTried(false); setBusy(false);
    // Only when it opens: a live update to the test mustn't wipe what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const nameErr = tried && !name.trim() ? 'Give the test a name.' : undefined;
  const urlErr = tried && !isHttpAddress(startUrl) ? 'Enter a full address, starting with https://' : undefined;
  const moved = startUrl.trim() !== test.startUrl && isHttpAddress(startUrl);
  const newVersion = moved && test.currentVersion > 0;

  const save = async () => {
    setTried(true);
    if (!name.trim() || !isHttpAddress(startUrl)) return;
    setBusy(true);
    try {
      const v = await backend.updateTestDetails(test.appId, test.id, { name, description, startUrl });
      onClose();
      toast(v && history ? `Saved as version ${v.number}` : 'Test details saved');
    } catch (e) {
      toast(e instanceof Error ? `Couldn't save: ${e.message}` : "Couldn't save the test details. Try again.", { error: true });
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Test details" width={520}
      actions={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button kind="primary" icon="check" busy={busy} onClick={save}>Save</Button>
      </>}>
      <form className="app-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="For example: Create a project" error={nameErr} autoFocus />
        <TextInput label={<span className="app-label-split">Description<span>Optional</span></span>} value={description}
          onChange={e => setDescription(e.target.value)} placeholder="What this test checks" />
        <TextInput label="Start address" mono value={startUrl} onChange={e => setStartUrl(e.target.value)} error={urlErr} spellCheck={false} autoCapitalize="off"
          hint={newVersion ? (history
            ? `Saved as version ${test.currentVersion + 1} with the same steps. Earlier versions keep their start address.`
            : 'The steps stay the same. Runs start at the new address from now on.') : undefined} />
        {newVersion && (
          <div className="app-lock" role="note"><Icon name="info" size={18} />Check the first steps still make sense from the new address.</div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

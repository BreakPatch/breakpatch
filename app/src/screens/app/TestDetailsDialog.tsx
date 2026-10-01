// Test details: a test's name, description and start address after it's made. Opened from the
// test's ⋯ menu on the Tests tab and from the recorder's title bar. The same checks as New test.
import { useEffect, useState } from 'react';
import { Button, Dialog, Icon, TextInput, useToast } from '../../components/ui';
import { useBackend } from '../../data/hooks';
import type { Test } from '../../data/types';
import { useFeature } from '../../edition';
import { isHttpAddress } from './tryCall';

/** "app.example.com/login" → "https://app.example.com/login": a bare host is taken as https (DES2-18). */
export function withScheme(url: string): string {
  const u = url.trim();
  if (!u || /^[a-z][a-z0-9+.-]*:/i.test(u) || /\s/.test(u)) return u;
  return /^(localhost|[^/]+\.[^/]+)(:\d+)?(\/|$)/i.test(u) ? `https://${u}` : u;
}

export function TestDetailsDialog({ open, test, onClose }: { open: boolean; test: Test; onClose: () => void }) {
  const backend = useBackend();
  const toast = useToast();
  const history = useFeature('versions');
  const [name, setName] = useState(test.name);
  const [description, setDescription] = useState(test.description ?? '');
  const [startUrl, setStartUrl] = useState(test.startUrl);
  const [tried, setTried] = useState(false);
  // Checked as each field is left, not only on Save.
  const [left, setLeft] = useState<{ name?: boolean; url?: boolean }>({});
  const [busy, setBusy] = useState(false);

  // Fresh from the test each time it opens.
  useEffect(() => {
    if (!open) return;
    setName(test.name); setDescription(test.description ?? ''); setStartUrl(test.startUrl);
    setTried(false); setBusy(false); setLeft({});
    // Only when it opens: a live update to the test mustn't wipe what's being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const url = withScheme(startUrl);
  const nameErr = (tried || left.name) && !name.trim() ? 'Give the test a name.' : undefined;
  const urlErr = (tried || left.url) && !isHttpAddress(url) ? 'Enter a full address, like https://app.example.com' : undefined;
  const moved = url !== test.startUrl && isHttpAddress(url);
  const newVersion = moved && test.currentVersion > 0;

  const save = async () => {
    setTried(true);
    if (!name.trim() || !isHttpAddress(url)) return;
    setBusy(true);
    try {
      const v = await backend.updateTestDetails(test.appId, test.id, { name, description, startUrl: url });
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
        <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} onBlur={() => setLeft(l => ({ ...l, name: true }))} placeholder="For example: Create a project" error={nameErr} autoFocus />
        <TextInput label={<span className="app-label-split">Description<span>Optional</span></span>} value={description}
          onChange={e => setDescription(e.target.value)} placeholder="What this test checks" />
        <TextInput label="Start address" mono value={startUrl} onChange={e => setStartUrl(e.target.value)} error={urlErr} spellCheck={false} autoCapitalize="off"
          onBlur={() => { setStartUrl(withScheme(startUrl)); setLeft(l => ({ ...l, url: true })); }} />
        {/* One note, in the future tense: nothing is saved until Save. */}
        {newVersion && (
          <div className="app-lock" role="note"><Icon name="info" size={18} />
            {history ? `Saves as version ${test.currentVersion + 1} with the same steps; earlier versions keep their start address.` : 'The steps stay the same, and runs start at the new address.'}
            {' '}Check the first steps still make sense from the new address.</div>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

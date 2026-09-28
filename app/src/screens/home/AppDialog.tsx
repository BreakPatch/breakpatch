// Add or edit an app: name, address and default screen size.
import { useEffect, useState } from 'react';
import { Button, Dialog, Field, TextInput, useToast } from '../../components/ui';
import { SCREEN_SIZES, SizePicker } from '../../components/common';
import { useBackend } from '../../data/hooks';
import type { App, Viewport } from '../../data/types';

/** Adds https:// when the user typed a bare host. */
export function normaliseAddress(s: string): string {
  const v = s.trim();
  if (!v) return v;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}

export function AppDialog({ open, app, onClose, onSaved }: { open: boolean; app?: App | null; onClose: () => void; onSaved?: (a: App) => void }) {
  const backend = useBackend();
  const toast = useToast();
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [size, setSize] = useState<Viewport>(SCREEN_SIZES[0].viewport);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(app?.name ?? ''); setAddress(app?.baseUrl ?? ''); setSize(app?.defaultViewport ?? SCREEN_SIZES[0].viewport);
    setTried(false); setBusy(false);
  }, [open, app]);

  const nameErr = tried && !name.trim() ? 'Give the app a name.' : undefined;
  const addrErr = tried && !address.trim() ? 'Add the address where tests start.' : undefined;

  const save = async () => {
    setTried(true);
    if (!name.trim() || !address.trim()) return;
    setBusy(true);
    try {
      const patch = { name: name.trim(), baseUrl: normaliseAddress(address), defaultViewport: size };
      if (app) { await backend.updateApp(app.id, patch); toast('App saved'); onSaved?.({ ...app, ...patch }); }
      else { const a = await backend.addApp(patch); toast(`${a.name} added`); onSaved?.(a); }
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Couldn't save the app", { error: true });
    } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} title={app ? 'Edit app' : 'Add an app'} width={480}
      actions={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" busy={busy} onClick={save}>{app ? 'Save' : 'Add app'}</Button></>}>
      <form className="home-form" onSubmit={e => { e.preventDefault(); void save(); }}>
        <TextInput label="Name" value={name} onChange={e => setName(e.target.value)} placeholder="Console" error={nameErr} autoFocus />
        <TextInput label="Address" mono value={address} onChange={e => setAddress(e.target.value)} placeholder="https://console.example.com"
          hint="Where new tests start. You can change it per test." error={addrErr} spellCheck={false} autoCapitalize="off" />
        <Field label="Default screen size" hint="New tests start with this. Each test's size is fixed once it's created.">
          <SizePicker value={size} onChange={setSize} label="Default screen size" />
        </Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

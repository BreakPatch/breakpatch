import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Dialog, Field, Icon, IconButton, Segmented, Skeleton, Switch, TextInput, useToast } from '../../../components/ui';
import { useBackend } from '../../../data/hooks';
import type { SecretInfo } from '../../../data/types';
import { secrets as keychain } from '../../../platform';
import { plural } from '../../../components/common/format';
import { edition } from '../../../edition';
import { useFeature } from '../../../edition/features';
import { parseSite, siteName } from '../../../lib/sites';
import { allowedIn, currentWorkspaceId, workspaceSecretNames } from '../../../lib/secretScope';
import { sortedConnections, useConnections, type Connection } from '../../../state/connections';
import { loadSecretUsage } from '../secretUsage';
import { Confirm, Section } from './common';
import { osText, thisComputer } from '../../../lib/osWords';

const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

/** A connection's name for a list of where a secret is kept; one no longer on this Mac says so. */
const workspaceName = (id: string, list: readonly Connection[]) => list.find(c => c.id === id)?.name ?? osText('a workspace no longer on this Mac');

function status(s: SecretInfo, connections: readonly Connection[], here: string | undefined): string {
  const used = s.usedBy ? `used by ${plural(s.usedBy, 'test')}` : '';
  if (!s.present) return used ? `Missing on ${thisComputer()} · ${used}` : `Missing on ${thisComputer()}`;
  const sites = s.origins.length ? `Allowed on ${s.origins.map(siteName).join(', ')}` : 'No sites yet';
  const kept = s.workspaces?.length ? `only in ${s.workspaces.map(id => workspaceName(id, connections)).join(', ')}` : '';
  const elsewhere = s.workspaces?.length && !allowedIn(s, here) ? (s.fromWorkspace ? "this workspace's own is used here" : 'not used here') : '';
  return [sites, kept, elsewhere, used || 'not used yet', s.runnerCanUse ? 'runner can use' : ''].filter(Boolean).join(' · ');
}

export function SecretsSection() {
  const backend = useBackend();
  const toast = useToast();
  const connections = useConnections(c => c.list);
  const [list, setList] = useState<SecretInfo[] | null>(null);
  const [editing, setEditing] = useState<{ secret?: SecretInfo } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const here = currentWorkspaceId();
  const Panel = edition.slots.secretsPanel;

  const load = useCallback(async () => {
    const [info, usage, shared] = await Promise.all([
      keychain.info(),
      loadSecretUsage(backend).catch(() => new Map<string, number>()),
      workspaceSecretNames(),
    ]);
    const byName = new Map(info.map(s => [s.name, s]));
    const fromWorkspace = new Set(shared.map(s => s.name));
    const ws = currentWorkspaceId();
    // A name the tests use that only the workspace has isn't missing: it's listed with the workspace's secrets.
    const all = new Set([...byName.keys(), ...[...usage.keys()].filter(n => !fromWorkspace.has(n))]);
    setList([...all].sort().map(name => {
      const p = byName.get(name);
      return {
        name, present: !!p, usedBy: usage.get(name) ?? 0, origins: p?.origins ?? [], runnerCanUse: p?.runnerCanUse ?? false,
        ...(p?.workspaces?.length ? { workspaces: p.workspaces } : {}),
        ...(p && fromWorkspace.has(name) && !allowedIn(p, ws) ? { fromWorkspace: true } : {}),
      };
    }));
  }, [backend]);
  useEffect(() => { void load().catch(() => setList([])); }, [load]);

  const remove = async (name: string) => {
    try { await keychain.remove(name); toast(`${name} deleted from ${thisComputer()}.`); await load(); }
    catch { toast("Couldn't delete the secret. Try again.", { error: true }); }
  };

  return (
    <Section title="Saved secrets">
      <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
        <p className="set-lead grow">{osText("Passwords and emails that tests type in. Values stay in this Mac's Keychain and are never uploaded. Tests only store the name, and each secret is only typed on the sites you allow.")}</p>
        <Button kind="primary" icon="add" onClick={() => setEditing({})}>Add secret</Button>
      </div>

      <div className="set-list" role="list" aria-label="Saved secrets">
        {!list && [0, 1, 2].map(i => <div key={i} className="set-secret"><Skeleton w={19} h={19} r={10} /><div className="grow col" style={{ gap: 6 }}><Skeleton w={220} /><Skeleton w={100} h={10} /></div></div>)}
        {list?.length === 0 && <div className="set-secret"><span className="set-secret-status" style={{ fontSize: 14 }}>No saved secrets yet. Add one, then pick it when a test writes into a field.</span></div>}
        {list?.map(s => (
          <div key={s.name} className={`set-secret${s.present ? '' : ' missing'}`} role="listitem">
            <Icon name={s.present ? 'key' : 'error'} label={s.present ? undefined : 'Missing'} />
            <div className="grow col" style={{ gap: 2, minWidth: 0 }}>
              <div className="set-secret-name">{s.name}</div>
              <div className="set-secret-status">{status(s, connections, here)}</div>
            </div>
            <div className="set-mask" aria-label={s.present ? 'Value hidden' : 'Not set'}>{s.present ? '••••••••' : 'Not set'}</div>
            <IconButton icon="edit" label={s.present ? `Change ${s.name}` : `Set ${s.name}`} onClick={() => setEditing({ secret: s })} />
            <IconButton icon="delete" label={`Delete ${s.name}`} disabled={!s.present} onClick={() => setDeleting(s.name)} />
          </div>
        ))}
      </div>
      <p className="set-note">{osText("If a test needs a secret that isn't on this Mac, or the page isn't one of the secret's sites, it stops before typing anything and tells you which one.")}</p>

      {Panel && <Panel />}

      {editing && <SecretDialog secret={editing.secret} taken={list?.filter(s => s.present).map(s => s.name) ?? []} connections={connections}
        onClose={() => setEditing(null)} onSaved={n => { toast(`${n} saved on ${thisComputer()}.`); void load(); }} />}
      <Confirm open={!!deleting} onClose={() => setDeleting(null)} icon="delete"
        title={`Delete ${deleting ?? ''}?`} confirm="Delete"
        text={osText("The value is removed from this Mac's Keychain. Tests that type it will stop before that step until you add it again.")}
        onConfirm={() => deleting ? remove(deleting) : undefined} />
    </Section>
  );
}

function SecretDialog({ secret, taken, connections, onClose, onSaved }: { secret?: SecretInfo; taken: string[]; connections: readonly Connection[]; onClose: () => void; onSaved: (name: string) => void }) {
  const fixed = secret?.name;
  const exists = !!secret?.present;
  // Team's local runner, or Solo's schedules on this Mac: both run tests unattended.
  const runnerOn = useFeature('runner'), schedulesOn = useFeature('schedules');
  const runnerFeature = runnerOn || schedulesOn;
  const [name, setName] = useState(fixed ?? '');
  const [value, setValue] = useState('');
  const [origins, setOrigins] = useState<string[]>(secret?.origins ?? []);
  const [site, setSite] = useState('');
  const [runner, setRunner] = useState(secret?.runnerCanUse ?? false);
  // Where it may be used (#33): every workspace and tests folder, or only those ticked.
  const [only, setOnly] = useState<string[]>(secret?.workspaces ?? []);
  const [limited, setLimited] = useState(!!secret?.workspaces?.length);
  const workspaces = limited ? only : [];
  // Only worth asking with more than one place to use it (or when it's limited already).
  const askWhere = connections.length > 1 || !!secret?.workspaces?.length;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const nameErr = !fixed && name && !NAME_RE.test(name) ? 'Use capital letters, numbers and _ only, starting with a letter.'
    : !fixed && taken.includes(name) ? osText('A secret with this name is already on this Mac.') : null;
  const typed = parseSite(site);
  const siteErr = site.trim() && !typed ? 'Enter a web address, like https://app.example.com' : null;
  const changed = value !== '' || origins.join() !== (secret?.origins ?? []).join() || runner !== (secret?.runnerCanUse ?? false)
    || workspaces.join() !== (secret?.workspaces ?? []).join();
  const whereErr = limited && !only.length ? 'Tick at least one, or choose Every workspace.' : null;
  // A new or missing secret needs its value; an existing one can change its sites alone.
  const ok = !!name && !nameErr && !siteErr && !whereErr && (exists ? changed : !!value);

  const addSite = () => {
    if (!typed) return;
    if (!origins.includes(typed)) setOrigins([...origins, typed]);
    setSite('');
  };

  const save = async () => {
    if (!ok) return;
    const all = typed && !origins.includes(typed) ? [...origins, typed] : origins;
    setBusy(true); setErr(null);
    try {
      if (value) await keychain.set(name, value, { origins: all, runnerCanUse: runner, workspaces });
      else await keychain.setPolicy(name, all, runner, workspaces);
      onSaved(name); onClose();
    } catch (e) {
      setErr(typeof e === 'string' ? e : osText("Couldn't save to the Keychain. Try again.")); setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={fixed ? (exists ? `Change ${fixed}` : `Set ${fixed}`) : 'Add a secret'} icon="key"
      sub={exists ? 'Change its sites, or type a new value to replace the old one.' : osText('Tests only store the name. The value stays on this Mac.')}
      actions={<><Button kind="ghost" onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!ok} busy={busy} onClick={() => void save()}>Save secret</Button></>}>
      <form className="col" style={{ gap: 14 }} onSubmit={e => { e.preventDefault(); void save(); }}>
        {!fixed && <TextInput label="Name" mono autoFocus placeholder="ACME_TEST_EMAIL" value={name} error={nameErr}
          onChange={e => setName(e.target.value.toUpperCase().replace(/[\s-]+/g, '_'))} autoComplete="off" spellCheck={false} />}
        <TextInput label="Value" type="password" value={value} onChange={e => setValue(e.target.value)} autoComplete="new-password"
          placeholder={exists ? 'Leave empty to keep the current value' : undefined}
          hint={osText("Saved in this Mac's Keychain. You won't see it again.")} />
        <Field label="Sites it may be typed on" error={siteErr}
          hint={origins.length ? 'Tests stop before typing it anywhere else, including after a redirect or in a popup.'
            : "Leave empty to allow the site of the app where it's first used. Breakpatch asks then."}>
          <div className="col" style={{ gap: 8 }}>
            {origins.length > 0 && (
              <div className="set-sites" role="list" aria-label="Allowed sites">
                {origins.map(o => (
                  <span key={o} className="set-site" role="listitem">
                    <span className="mono">{siteName(o)}</span>
                    <IconButton icon="close" size={16} label={`Remove ${siteName(o)}`} onClick={() => setOrigins(origins.filter(x => x !== o))} />
                  </span>
                ))}
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              <TextInput aria-label="Add a site" mono placeholder="https://app.example.com" value={site} spellCheck={false} autoCapitalize="off"
                onChange={e => setSite(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSite(); } }} />
              <Button icon="add" disabled={!typed} onClick={addSite}>Add</Button>
            </div>
          </div>
        </Field>
        {askWhere && (
          <Field label="Where it may be used" error={whereErr}
            hint={limited ? osText('Tests in other workspaces and tests folders stop before typing it, and say why.') : 'In every workspace and tests folder, as before.'}>
            <div className="col" style={{ gap: 8 }}>
              <Segmented label="Where it may be used" value={limited ? 'only' : 'every'} onChange={v => setLimited(v === 'only')}
                items={[{ value: 'every', label: 'Every workspace' }, { value: 'only', label: 'Only these' }]} />
              {limited && (
                <div className="set-where" role="group" aria-label="Workspaces it may be used in">
                  {sortedConnections([...connections]).map(c => (
                    <Checkbox key={c.id} label={c.name} checked={only.includes(c.id)}
                      onChange={v => setOnly(v ? [...only, c.id] : only.filter(x => x !== c.id))} />
                  ))}
                  {only.filter(id => !connections.some(c => c.id === id)).map(id => (
                    <Checkbox key={id} label={workspaceName(id, connections)} checked onChange={() => setOnly(only.filter(x => x !== id))} />
                  ))}
                </div>
              )}
            </div>
          </Field>
        )}
        {(runnerFeature || runner) && (
          <label className="set-runner-flag">
            <Switch checked={runner} onChange={setRunner} label="Runner can use" />
            <span>Runner can use<span className="set-note" style={{ display: 'block', margin: 0 }}>{osText('The local runner and scheduled runs may type it in tests they run unattended on this Mac. Off by default.')}</span></span>
          </label>
        )}
        {err && <p className="set-note" role="alert" style={{ color: 'var(--failed)', margin: 0 }}>{err}</p>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

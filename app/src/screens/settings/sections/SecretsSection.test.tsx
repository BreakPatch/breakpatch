import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../../../components/ui';
import { DemoBackend } from '../../../data/demo/demoBackend';
import { NO_FEATURES } from '../../../edition/types';
import { resetFeaturesForTests, setFeatures } from '../../../edition/features';
import { setOsForTests } from '../../../lib/osWords';
import { secrets } from '../../../platform';
import { useSession } from '../../../state/session';
import { folderConnection, useConnections } from '../../../state/connections';
import { edition } from '../../../edition';
import { SecretsSection } from './SecretsSection';

const info = async (name: string) => (await secrets.info()).find(s => s.name === name);

function show() {
  render(<ToastProvider><SecretsSection /></ToastProvider>);
}

beforeEach(async () => {
  useSession.setState({ backend: new DemoBackend({ empty: true, signedIn: true, delayMs: 0 }) });
  await secrets.set('STAGING_TOKEN', 'tok', { origins: ['https://app.example.com'], runnerCanUse: false });
});
afterEach(async () => { cleanup(); setOsForTests(null); resetFeaturesForTests(); await secrets.remove('STAGING_TOKEN'); await secrets.remove('NEW_ONE').catch(() => {}); });

describe('Settings, Saved secrets', () => {
  it('names the system\'s own store off the Mac', async () => {
    setOsForTests('linux');
    show();
    expect(await screen.findByText(/Values stay in this PC's keyring/)).toBeTruthy();
    cleanup();
    setOsForTests('windows');
    show();
    expect(await screen.findByText(/Values stay in this PC's Credential Manager/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bMac\b|Keychain/);
  });

  it('lists each secret with the sites it may be typed on', async () => {
    show();
    const row = (await screen.findByText('STAGING_TOKEN')).closest('[role="listitem"]') as HTMLElement;
    expect(within(row).getByText(/Allowed on app\.example\.com/)).toBeTruthy();
  });

  it('adds a site to an existing secret without asking for its value again', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Change STAGING_TOKEN' }));
    const add = screen.getByRole('textbox', { name: 'Add a site' });
    fireEvent.change(add, { target: { value: 'api.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('list', { name: 'Allowed sites' }).textContent).toContain('api.example.com');
    fireEvent.click(screen.getByRole('button', { name: 'Remove app.example.com' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(async () => expect((await info('STAGING_TOKEN'))?.origins).toEqual(['https://api.example.com']));
    expect((await secrets.resolve(['STAGING_TOKEN'])).STAGING_TOKEN).toBe('tok');
  });

  it('saves a new secret with the site you type, the runner off', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add secret' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'NEW_ONE' } });
    fireEvent.change(screen.getByLabelText('Value'), { target: { value: 'v' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Add a site' }), { target: { value: 'https://login.example.com/sso' } });
    expect(screen.queryByRole('switch', { name: 'Runner can use' })).toBeNull();   // Community: no runner
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(async () => expect(await info('NEW_ONE')).toEqual({ name: 'NEW_ONE', origins: ['https://login.example.com'], runnerCanUse: false }));
  });

  it('keeps a secret for chosen workspaces, and says where (#33)', async () => {
    const mine = folderConnection('/Users/ana/Tests', 'My tests');
    const acme = { id: 'team:acme-tests/breakpatch', kind: 'team' as const, name: 'Acme QA', lastOpenedAt: 1, team: { workspace: { name: 'Acme QA', config: { apiKey: 'k', authDomain: 'a', projectId: 'acme-tests', appId: 'x' }, database: 'breakpatch', domain: 'acme.example' } } };
    useConnections.setState({ list: [mine, acme], activeId: mine.id });
    useSession.setState({ local: { path: '/Users/ana/Tests' }, workspace: null });
    try {
      show();
      fireEvent.click(await screen.findByRole('button', { name: 'Change STAGING_TOKEN' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Only these' }));
      expect(screen.getByRole('button', { name: 'Save secret' }).hasAttribute('disabled')).toBe(true);   // none ticked yet
      fireEvent.click(screen.getByRole('checkbox', { name: 'Acme QA' }));
      fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
      await waitFor(async () => expect((await info('STAGING_TOKEN'))?.workspaces).toEqual([acme.id]));
      expect((await secrets.resolve(['STAGING_TOKEN'])).STAGING_TOKEN).toBe('tok');
      const row = (await screen.findByText('STAGING_TOKEN')).closest('[role="listitem"]') as HTMLElement;
      await waitFor(() => expect(within(row).getByText(/only in Acme QA · not used here/)).toBeTruthy());
      // Back to every workspace. Choosing doesn't save by itself: Save does.
      fireEvent.click(screen.getByRole('button', { name: 'Change STAGING_TOKEN' }));
      fireEvent.click(screen.getByRole('tab', { name: 'Every workspace' }));
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect((await info('STAGING_TOKEN'))?.workspaces).toEqual([acme.id]);
      fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
      await waitFor(async () => expect((await info('STAGING_TOKEN'))?.workspaces).toBeUndefined());
    } finally {
      useConnections.setState({ list: [], activeId: null });
    }
  });

  it("doesn't ask where with one place to use it", async () => {
    useConnections.setState({ list: [], activeId: null });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Change STAGING_TOKEN' }));
    expect(screen.queryByRole('tab', { name: 'Only these' })).toBeNull();
  });

  it("doesn't call a name the workspace has missing, and shows the edition's panel", async () => {
    const before = { ws: edition.workspaceSecrets, panel: edition.slots.secretsPanel };
    edition.workspaceSecrets = { names: async () => [{ name: 'SHARED_PW', runnerCanUse: false }], sealed: async () => [] };
    edition.slots.secretsPanel = () => <p>The workspace's secrets</p>;
    const b = new DemoBackend({ signedIn: true, delayMs: 0 });
    useSession.setState({ backend: b });
    try {
      show();
      expect(await screen.findByText("The workspace's secrets")).toBeTruthy();
      await screen.findByText('STAGING_TOKEN');
      expect(screen.queryByText('SHARED_PW')).toBeNull();
    } finally {
      edition.workspaceSecrets = before.ws; edition.slots.secretsPanel = before.panel;
    }
  });

  it('offers "Runner can use" where the runner is, off by default', async () => {
    setFeatures({ ...NO_FEATURES, runner: true });
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Change STAGING_TOKEN' }));
    const sw = screen.getByRole('switch', { name: 'Runner can use' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(sw);
    fireEvent.click(screen.getByRole('button', { name: 'Save secret' }));
    await waitFor(async () => expect((await info('STAGING_TOKEN'))?.runnerCanUse).toBe(true));
  });
});

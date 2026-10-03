import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../../../components/ui';
import { DemoBackend } from '../../../data/demo/demoBackend';
import { NO_FEATURES } from '../../../edition/types';
import { resetFeaturesForTests, setFeatures } from '../../../edition/features';
import { setOsForTests } from '../../../lib/osWords';
import { secrets } from '../../../platform';
import { useSession } from '../../../state/session';
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

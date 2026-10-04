import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ToastProvider } from '../../../components/ui';
import { DemoBackend } from '../../../data/demo/demoBackend';
import { useSession } from '../../../state/session';
import { DeletedSection } from './DeletedSection';

afterEach(cleanup);
const VP = { width: 1440, height: 900, dpr: 1 as const };

async function withDeleted() {
  const backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend, user: backend.currentUser() });
  const app = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com', viewport: VP });
  await backend.deleteTest(app.id, t.id);
  render(<ToastProvider><DeletedSection /></ToastProvider>);
  return { backend, app, t };
}

describe('Settings → Recently deleted', () => {
  it('lists what was deleted, when and how long it stays, and restores it', async () => {
    const { backend, app } = await withDeleted();
    const row = await screen.findByRole('listitem');
    expect(within(row).getByText('Log in')).toBeInTheDocument();
    expect(within(row).getByText(/^Test in Web app · Deleted today, \d\d:\d\d · 30 days left$/)).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }));
    await screen.findByText('Nothing deleted in the last 30 days.');
    const tests = await new Promise<unknown[]>(res => { const off = backend.tests(app.id, v => { setTimeout(off); res(v); }); });
    expect(tests).toHaveLength(1);
  });

  it('asks before Delete now, and says it cannot be undone', async () => {
    await withDeleted();
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Log in now' }));
    expect(screen.getByText('Delete "Log in" now?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete now' }));
    await screen.findByText('Nothing deleted in the last 30 days.');
  });

  it('lets a member restore only their own draft tests', async () => {
    const { backend } = await withDeleted();
    backend.myRole = () => 'member';
    useSession.setState({ user: { uid: 'someone-else', name: 'Bo', email: 'bo@acme.example' } });
    cleanup();
    render(<ToastProvider><DeletedSection /></ToastProvider>);
    const row = await screen.findByRole('listitem');
    await waitFor(() => expect(within(row).getByRole('button', { name: 'Restore' })).toBeDisabled());
    // Said in the row, not only in a tooltip.
    expect(within(row).getByText('Only admins can restore this')).toBeVisible();
  });
});

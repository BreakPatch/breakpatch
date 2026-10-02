// Deleting shared steps (Recently deleted): only while no test uses them, and the confirm says
// where they go.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { App, StepGroup, Test } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { ToastProvider } from '../../components/ui';
import { SharedTab } from './SharedTab';

const VP = { width: 1440, height: 900, dpr: 1 as const };
let backend: DemoBackend;
let app: App;

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend });
  app = await backend.addApp({ name: 'Web', baseUrl: 'https://app.example.com', defaultViewport: VP });
});
afterEach(cleanup);

const groupsNow = () => new Promise<StepGroup[]>(r => { const off = backend.stepGroups(app.id, v => { setTimeout(() => off()); r(v); }); });
const open = (groups: StepGroup[], tests: Test[]) => render(<MemoryRouter><ToastProvider><SharedTab app={app} groups={groups} tests={tests} /></ToastProvider></MemoryRouter>);
const menuDelete = (name: string) => {
  fireEvent.click(screen.getByRole('button', { name: `More for ${name}` }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
};

describe('Delete shared steps', () => {
  it('moves them to Recently deleted, after saying so', async () => {
    const g = await backend.createGroup(app.id, 'Sign in', '', []);
    open([g], []);
    menuDelete('Sign in');
    expect(screen.getByText(/They go to Recently deleted\. You can restore them there for 30 days\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete shared steps' }));
    await waitFor(async () => expect(await groupsNow()).toEqual([]));
    await screen.findByText('Sign in moved to Recently deleted.');
  });

  it('waits while a test uses them, and counts only tests that are there', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com', viewport: VP });
    const g = { ...(await backend.createGroup(app.id, 'Sign in', '', [])), usedBy: [{ testId: t.id, version: 'latest' as const }, { testId: 'deleted-one', version: 1 }] };
    open([g], [t]);
    menuDelete('Sign in');
    expect(screen.getByText('1 test uses these shared steps. Take them out of that test first, then delete them.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    expect(await groupsNow()).toHaveLength(1);
  });

  it('is for admins only', async () => {
    const g = await backend.createGroup(app.id, 'Sign in', '', []);
    backend.myRole = () => 'member';
    open([g], []);
    fireEvent.click(screen.getByRole('button', { name: 'More for Sign in' }));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });
});

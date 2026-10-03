// Deleting shared steps (Recently deleted): only while no test uses them. It goes at once, and the
// toast says where, with Undo.
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
  it('moves them to Recently deleted at once, and Undo puts them back', async () => {
    const g = await backend.createGroup(app.id, 'Sign in', '', []);
    open([g], []);
    menuDelete('Sign in');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(async () => expect(await groupsNow()).toEqual([]));
    await screen.findByText('"Sign in" moved to Recently deleted.');
    expect(screen.getByRole('button', { name: 'Open Recently deleted' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () => expect((await groupsNow()).map(x => x.name)).toEqual(['Sign in']));
    await screen.findByText('"Sign in" is back.');
  });

  it('can’t be deleted while a test uses them, and says how many (counting only tests that are there)', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com', viewport: VP });
    const g = { ...(await backend.createGroup(app.id, 'Sign in', '', [])), usedBy: [{ testId: t.id, version: 'latest' as const }, { testId: 'deleted-one', version: 1 }] };
    open([g], [t]);
    fireEvent.click(screen.getByRole('button', { name: 'More for Sign in' }));
    const del = screen.getByRole('menuitem', { name: /^Delete/ });
    expect(del).toBeDisabled();
    expect(del).toHaveTextContent('Used by 1 test. Take them out first.');
    fireEvent.click(del);
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

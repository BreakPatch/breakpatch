// Test details: a test's name, description and start address can be changed after it's made,
// from the ⋯ menu on the Tests tab and from the recorder.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Test, Version } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { TestsTab } from './TestsTab';
import { TestDetailsDialog } from './TestDetailsDialog';
import recorderSource from '../recorder/RecorderScreen.tsx?raw';

const VP = { width: 1440, height: 900, dpr: 1 as const };
let backend: DemoBackend;
let app: App;

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend });
  app = await backend.addApp({ name: 'Web', baseUrl: 'https://app.example.com', defaultViewport: VP });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const testNow = (id: string) => new Promise<Test | null>(r => { const off = backend.test(app.id, id, t => { setTimeout(() => off()); r(t); }); });
const versionsNow = (id: string) => new Promise<Version[]>(r => { const off = backend.versions(app.id, id, v => { setTimeout(() => off()); r(v); }); });

async function recordedTest() {
  const t = await backend.createTest({ appId: app.id, name: 'Log in', description: 'Signs in', startUrl: 'https://app.example.com/login', viewport: VP });
  await backend.saveTest(app.id, t.id, [{ id: 's1', action: 'click', label: 'Click Log in', at: [10, 10] }]);
  return (await testNow(t.id))!;
}

describe('Test details from the Tests tab', () => {
  it('is in the ⋯ menu and opens with the test as it is', async () => {
    const t = await recordedTest();
    render(<MemoryRouter><TestsTab app={app} tests={[t]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'More for Log in' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Test details/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Test details' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Log in');
    expect(screen.getByLabelText(/Description/)).toHaveValue('Signs in');
    expect(screen.getByLabelText('Start address')).toHaveValue('https://app.example.com/login');
    expect(screen.getByRole('menuitem', { hidden: true, name: /Edit steps/ })).toBeDefined();
  });
});

describe('the Test details dialog', () => {
  it('checks the name and the address like New test does, and saves nothing until they are right', async () => {
    const t = await recordedTest();
    const save = vi.spyOn(backend, 'updateTestDetails');
    render(<TestDetailsDialog open test={t} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  ' } });
    fireEvent.change(screen.getByLabelText('Start address'), { target: { value: 'app.example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give the test a name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a full address, starting with https://')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('renames and describes without a new version', async () => {
    const t = await recordedTest();
    const onClose = vi.fn();
    render(<TestDetailsDialog open test={t} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' Sign in ' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: '' } });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const after = await testNow(t.id);
    expect(after).toMatchObject({ name: 'Sign in', startUrl: 'https://app.example.com/login', currentVersion: 1 });
    expect(after?.description).toBeUndefined();
  });

  it('saves a new start address as a new version with the same steps, and the old version keeps its own', async () => {
    const t = await recordedTest();
    const onClose = vi.fn();
    render(<TestDetailsDialog open test={t} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText('Start address'), { target: { value: 'https://app.example.com/signin' } });
    expect(screen.getByRole('note')).toHaveTextContent('Check the first steps still make sense from the new address.');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await testNow(t.id)).toMatchObject({ startUrl: 'https://app.example.com/signin', currentVersion: 2, stepCount: 1 });
    const [v2, v1] = await versionsNow(t.id);
    expect(v2).toMatchObject({ number: 2, startUrl: 'https://app.example.com/signin', note: 'Start address changed to https://app.example.com/signin' });
    expect(v2.steps).toEqual(v1.steps);
    expect(v1.startUrl).toBe('https://app.example.com/login');
  });

  it('on a test with no steps yet the address changes without a version', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Empty', startUrl: 'https://app.example.com', viewport: VP });
    render(<TestDetailsDialog open test={t} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText('Start address'), { target: { value: 'https://app.example.com/start' } });
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await waitFor(async () => expect(await testNow(t.id)).toMatchObject({ startUrl: 'https://app.example.com/start', currentVersion: 0 }));
    expect(await versionsNow(t.id)).toEqual([]);
  });
});

describe('Test details in the recorder', () => {
  it('has a Test details button, and the browser stays on the address it opened at', () => {
    expect(recorderSource).toContain('<IconButton icon="description" label="Test details"');
    expect(recorderSource).toContain('<TestDetailsDialog open={detailsOpen} test={test}');
    expect(recorderSource).toContain('useBrowserSession(openedAt.current?.url');
  });
});

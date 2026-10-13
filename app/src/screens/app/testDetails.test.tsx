// Test details: a test's name, description and start address can be changed after it's made,
// from the ⋯ menu on the Tests tab and from the recorder.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Test, Version } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { TestsTab } from './TestsTab';
import { TestDetailsDialog } from './TestDetailsDialog';
import { ToastProvider } from '../../components/ui';
import { getEngine } from '../../engine';
import RecorderScreen from '../recorder/RecorderScreen';

// The CSS as written (vitest leaves CSS imports empty: `css: false`).
const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const here = dirname(fileURLToPath(import.meta.url));
const shellCss = fs.readFileSync(join(here, '../../components/shell/shell.css'), 'utf8');
const globalCss = fs.readFileSync(join(here, '../../styles/global.css'), 'utf8');

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
Element.prototype.scrollIntoView ??= () => undefined;

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
  it('is first in the ⋯ menu and opens with the test as it is', async () => {
    const t = await recordedTest();
    render(<MemoryRouter><TestsTab app={app} tests={[t]} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'More for Log in' }));
    const items = screen.getAllByRole('menuitem');
    expect(items.slice(0, 2).map(i => i.textContent)).toEqual(['descriptionTest details…', 'editEdit steps']);
    fireEvent.click(items[0]);
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
    fireEvent.change(screen.getByLabelText('Start address'), { target: { value: 'not an address' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Give the test a name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a full address, like https://app.example.com')).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it('checks each field as it is left, and takes a bare host as https (DES2-18)', async () => {
    const t = await recordedTest();
    render(<TestDetailsDialog open test={t} onClose={() => {}} />);
    const name = screen.getByLabelText('Name');
    fireEvent.change(name, { target: { value: ' ' } });
    fireEvent.blur(name);
    expect(screen.getByText('Give the test a name.')).toBeInTheDocument();
    const address = screen.getByLabelText('Start address');
    fireEvent.change(address, { target: { value: 'app.example.com/signin' } });
    fireEvent.blur(address);
    expect(address).toHaveValue('https://app.example.com/signin');
    expect(screen.queryByText(/Enter a full address/)).toBeNull();
    // A future-tense note, said once: nothing is saved yet.
    expect(screen.getByRole('note')).toHaveTextContent(/(Saves as version 2 with the same steps; earlier versions keep their start address|The steps stay the same, and runs start at the new address)\. Check the first steps/);
    expect(screen.queryByText(/Saved as version/)).toBeNull();
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
  it("the title bar doesn't cut off the focus ring round the test's name: the ellipsis is on the text inside", () => {
    // A lint-style guard of shell.css's rules (jsdom lays nothing out): the h1 clips nothing; a
    // plain title's text and the button's name each cut themselves off with an ellipsis.
    const css = shellCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Map([...css.matchAll(/^([^{}\n]+?) \{([^}]*)\}/gm)].map(m => [m[1].trim(), m[2]]));
    const rule = (sel: string) => { expect(rules.has(sel), sel).toBe(true); return rules.get(sel) ?? ''; };
    expect(rule('.titlebar-title h1')).toMatch(/font-size: 15px/);
    expect(rule('.titlebar-title h1')).not.toMatch(/overflow/);
    expect(rule('.titlebar-text')).toMatch(/overflow: hidden; text-overflow: ellipsis/);
    expect(rule('.titlebar-name > span:first-child')).toMatch(/overflow: hidden; text-overflow: ellipsis/);
    expect(globalCss).toMatch(/:focus-visible \{[^}]*outline-offset: 2px/);     // the ring is outside the button
  });


  it('opens from the test\'s name in the title bar, and the browser stays on the address it opened at', async () => {
    const t = await recordedTest();
    const opened = vi.spyOn(getEngine(), 'openBrowser');
    render(<ToastProvider><MemoryRouter initialEntries={[`/apps/${app.id}/tests/${t.id}/record`]}>
      <Routes><Route path="/apps/:appId/tests/:testId/record" element={<RecorderScreen />} /></Routes>
    </MemoryRouter></ToastProvider>);
    // The name is the button, with a pencil and the tooltip "Test details"; there's no other one to find.
    // Its accessible name is the test's, and "Test details" is said once, as its description.
    const name = await screen.findByRole('button', { name: 'Log in' });
    expect(name).toHaveAccessibleName('Log in');
    expect(name).toHaveAccessibleDescription('Test details');
    expect(name).toHaveAttribute('title', 'Test details');
    expect(name).not.toHaveAttribute('aria-label');
    expect(screen.getByRole('heading', { level: 1 })).toContainElement(name);
    expect(name.querySelector('.icon')).toHaveTextContent('edit');
    expect(screen.getAllByRole('button', { description: 'Test details' })).toEqual([name]);
    fireEvent.click(within(name).getByText('Log in'));
    const dialog = await screen.findByRole('dialog', { name: 'Test details' });
    expect(dialog).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Start address'), { target: { value: 'https://app.example.com/signin' } });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Save' })); });
    await waitFor(async () => expect(await testNow(t.id)).toMatchObject({ startUrl: 'https://app.example.com/signin' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Test details' })).not.toBeInTheDocument());
    // The new address is for the next run: the page being recorded on isn't reopened.
    expect(opened.mock.calls.map(c => c[0])).toEqual(['https://app.example.com/login']);
  });
});

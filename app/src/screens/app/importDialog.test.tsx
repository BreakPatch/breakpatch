// Import a test (roadmap #16): the Import… button on an app's Tests tab, the dialog's preview of
// the steps a script maps to and the lines it leaves out, and the new test opening in the
// recorder, which learns the steps by itself.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, Test, Version } from '../../data/types';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import { ToastProvider } from '../../components/ui';
import { getEngine } from '../../engine';
import * as platform from '../../platform';
import AppScreen from './AppScreen';
import RecorderScreen from '../recorder/RecorderScreen';
import { ImportDialog } from './ImportDialog';
import { leftOutNote, NOTHING_FOUND } from '../../lib/scriptImport';
import { hasImport, takeImport } from '../../lib/scriptImport/pending';
import codegen from '../../lib/scriptImport/fixtures/codegen-todo.spec.ts.txt?raw';

vi.mock('../../platform', async orig => ({ ...await orig<typeof import('../../platform')>(), openNamedTextFile: vi.fn() }));

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
Element.prototype.scrollIntoView ??= () => undefined;

const VP = { width: 1440, height: 900, dpr: 1 as const };
let backend: DemoBackend;
let app: App;

beforeEach(async () => {
  backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
  useSession.setState({ backend });
  app = await backend.addApp({ name: 'Shop', baseUrl: 'https://shop.example.com', defaultViewport: VP });
  vi.spyOn(platform.secrets, 'info').mockResolvedValue([{ name: 'SHOP_PASSWORD', origins: ['https://shop.example.com'], runnerCanUse: false }]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.mocked(platform.openNamedTextFile).mockReset(); });

const testsNow = () => new Promise<Test[]>(r => { const off = backend.tests(app.id, t => { setTimeout(() => off()); r(t); }); });
const versionNow = (id: string) => new Promise<Version | null>(r => { backend.version(app.id, id, 1).then(r); });

const LOGIN = `import { test, expect } from '@playwright/test';
test('Log in', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('ada@example.com');
  await page.getByLabel('Password').fill(process.env.SHOP_PASSWORD!);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL('/home');
  await page.waitForLoadState();
  await expect(page.getByText('Welcome, Ada')).toBeVisible();
});
test('Log out', async ({ page }) => {
  await page.goto('/home');
  await page.getByRole('button', { name: 'Log out' }).click();
});`;

function dialog(onClose = vi.fn()) {
  render(<ToastProvider><MemoryRouter initialEntries={['/apps/x']}>
    <Routes>
      <Route path="/apps/x" element={<ImportDialog open app={app} onClose={onClose} />} />
      <Route path="/apps/:appId/tests/:testId/record" element={<div>recorder</div>} />
    </Routes>
  </MemoryRouter></ToastProvider>);
  return onClose;
}
const paste = (text: string) => {
  fireEvent.click(screen.getByRole('button', { name: 'Paste the script instead' }));
  fireEvent.change(screen.getByLabelText('Script'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Read the script' }));
};

describe('the Import dialog', () => {
  it('previews the steps and the lines it left out, then creates the test and hands the steps to the recorder', async () => {
    const onClose = dialog();
    paste(LOGIN);
    expect(await screen.findByLabelText('Name')).toHaveValue('Log in');
    expect(screen.getByLabelText('Start address')).toHaveValue('https://shop.example.com/login');
    expect(screen.getByLabelText(/^Test/)).toHaveValue('0');
    const steps = within(screen.getByRole('region', { name: 'Steps' })).getAllByRole('listitem');
    expect(steps.map(li => li.querySelector('.grow')!.firstChild!.textContent)).toEqual([
      'Type "ada@example.com" into the "Email" field',
      'Type into the "Password" field',
      'Click the "Log in" button',
      'Check that "Welcome, Ada" shows',
    ]);
    expect(steps[1]).toHaveTextContent('The script reads SHOP_PASSWORD.');
    expect(within(screen.getByRole('region', { name: 'Not imported' })).getByText(/not the page's address or title/)).toBeInTheDocument();
    // Not needed: folded away until asked for.
    expect(screen.queryByText(/waits for the page to settle/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Not needed/ }));
    expect(screen.getByText(/waits for the page to settle/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Create and learn' }));
    expect(await screen.findByText('recorder')).toBeInTheDocument();
    expect(onClose).toHaveBeenCalled();
    const [made] = await testsNow();
    expect(made).toMatchObject({ name: 'Log in', startUrl: 'https://shop.example.com/login', viewport: VP, stepCount: 0 });
    const held = takeImport(app.id, made.id)!;
    // The saved secret with the environment variable's name is used; nothing else of the script is kept.
    expect(held.steps).toEqual([
      { action: 'write', target: 'the "Email" field', text: 'ada@example.com' },
      { action: 'write', target: 'the "Password" field', secretRef: 'SHOP_PASSWORD' },
      { action: 'click', target: 'the "Log in" button' },
      { action: 'checkpoint', target: '"Welcome, Ada"' },
    ]);
    expect(held.note).toBe("One line of the script wasn't imported.");
  });

  it('lets you pick another test in the file, and checks the name and address', async () => {
    dialog();
    paste(LOGIN);
    fireEvent.change(await screen.findByLabelText(/^Test/), { target: { value: '1' } });
    expect(screen.getByLabelText('Name')).toHaveValue('Log out');
    expect(screen.getByLabelText('Start address')).toHaveValue('https://shop.example.com/home');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: ' ' } });
    fireEvent.change(screen.getByLabelText('Start address'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and learn' }));
    expect(await screen.findByText('Give the test a name.')).toBeInTheDocument();
    expect(screen.getByText('Enter a full address, like https://app.example.com')).toBeInTheDocument();
    expect(await testsNow()).toEqual([]);
  });

  it('reads a chosen file, names the test after it, and says when a file has no test', async () => {
    vi.mocked(platform.openNamedTextFile).mockResolvedValueOnce({ name: 'todo.spec.ts', text: codegen });
    dialog();
    fireEvent.click(screen.getByRole('button', { name: 'Choose a script…' }));
    expect(await screen.findByLabelText('Name')).toHaveValue('Todo');
    expect(screen.getByText('Playwright · todo.spec.ts')).toBeInTheDocument();
    expect(vi.mocked(platform.openNamedTextFile).mock.calls[0][0]).toEqual(expect.arrayContaining(['ts', 'js']));
    fireEvent.click(screen.getByRole('button', { name: 'Another script' }));
    vi.mocked(platform.openNamedTextFile).mockResolvedValueOnce({ name: 'readme.js', text: 'console.log("hi")' });
    fireEvent.click(screen.getByRole('button', { name: 'Choose a script…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(NOTHING_FOUND);
    vi.mocked(platform.openNamedTextFile).mockRejectedValueOnce(new Error('This file is too big to be a test script.'));
    fireEvent.click(screen.getByRole('button', { name: 'Choose a script…' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('too big'));
  });

  it("won't create a test with no steps", async () => {
    dialog();
    paste("test('a', async ({ page }) => { await page.goto('/'); await signIn(page) })");
    expect(await screen.findByText(/Nothing in this test can be a step/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and learn' })).toBeDisabled();
    expect(screen.getByText(/signIn\(\) is your own code/)).toBeInTheDocument();
  });

  it('says how many lines were left out, counting a line once', () => {
    expect(leftOutNote({ name: 'a', steps: [], skipped: [] })).toBeUndefined();
    expect(leftOutNote({ name: 'a', steps: [], skipped: [{ line: 3, code: '', why: 'x' }, { line: 3, code: '', why: 'y' }, { line: 4, code: '', why: 'z', notNeeded: true }] }))
      .toBe("One line of the script wasn't imported.");
  });
});

describe('from the Tests tab to a learned test', () => {
  it('Import… on the app makes the test, and the recorder learns its steps by itself', { timeout: 30000 }, async () => {
    const point = vi.spyOn(getEngine(), 'recordPoint').mockImplementation(async p => ({ id: `s${Math.random().toString(36).slice(2)}`, action: p.action, label: `${p.action} step`, at: p.at, text: p.text, secretRef: p.secretRef }));
    vi.spyOn(getEngine(), 'locate').mockImplementation(async what => ({ box: [10, 10, 50, 30], at: [30, 20], target: what, frame: 1, path: 'fast' }));
    vi.spyOn(getEngine(), 'recordCheckpoint').mockImplementation(async region => ({ id: 'c1', action: 'checkpoint', label: 'x', region, hash: '0', tolerance: 8 }));
    vi.spyOn(platform.secrets, 'resolve').mockResolvedValue({ SHOP_PASSWORD: 'pw' });
    render(<ToastProvider><MemoryRouter initialEntries={[`/apps/${app.id}`]}>
      <Routes>
        <Route path="/apps/:appId" element={<AppScreen />} />
        <Route path="/apps/:appId/tests/:testId/record" element={<RecorderScreen />} />
      </Routes>
    </MemoryRouter></ToastProvider>);
    // Generous waits: the recorder opens its browser first, slower when the whole suite runs at once.
    const slow = { timeout: 8000 };
    fireEvent.click(await screen.findByRole('button', { name: 'Import from Playwright or Cypress' }, slow));
    paste(LOGIN);
    fireEvent.click(await screen.findByRole('button', { name: 'Create and learn' }, slow));
    expect(await screen.findByRole('region', { name: 'Steps from your script' }, slow)).toBeInTheDocument();
    expect(await screen.findByText(/^4 steps learned\./, {}, slow)).toBeInTheDocument();
    expect(point.mock.calls.map(c => c[0].action)).toEqual(['write', 'write', 'click']);
    const [made] = await testsNow();
    expect(hasImport(app.id, made.id)).toBe(false);
    // Learned, not saved: Save keeps the steps with their checks.
    fireEvent.click(screen.getByRole('button', { name: /^Save/ }));
    await waitFor(async () => expect((await versionNow(made.id))?.steps.map(s => s.action)).toEqual(['write', 'write', 'click', 'checkpoint']), slow);
  });
});

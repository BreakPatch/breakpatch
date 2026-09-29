// Community's one-time usage notice and Settings → Privacy (docs/manual.md "Privacy"), with the
// browser stand-in for the shell (lib/usage.ts): nothing is sent from a browser.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pendingLine, resetUsageMemory, usage } from '../../lib/usage';
import { PrivacySection } from '../../screens/settings/sections/PrivacySection';
import { NOTICE_TEXT, UsageNotice } from './UsageNotice';

// The same whichever edition this checkout builds (the Team module may be linked in).
const ed = vi.hoisted(() => ({ edition: { name: 'community' as 'community' | 'team', gate: { paths: ['/welcome'] } } }));
vi.mock('../../edition', () => ed);

beforeEach(() => { resetUsageMemory(); ed.edition.name = 'community'; });
afterEach(cleanup);

const at = (path: string) => render(<MemoryRouter initialEntries={[path]}><UsageNotice /></MemoryRouter>);

describe('the one-time usage notice (Community)', () => {
  it('says exactly what is counted, once, and OK keeps it on', async () => {
    at('/');
    expect(await screen.findByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(NOTICE_TEXT).toBe('Breakpatch counts tests created and runs, as anonymous totals for all users. No names, addresses, screenshots or IDs are sent.');
    fireEvent.click(screen.getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument());   // after its way out
    await waitFor(async () => expect((await usage.settings()).noticeSeen).toBe(true));
    expect((await usage.settings()).enabled).toBe(true);

    cleanup();
    at('/');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
  });

  it('Turn off stops the counting and drops what was waiting', async () => {
    usage.testCreated();
    at('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn off' }));
    await waitFor(async () => expect((await usage.settings()).enabled).toBe(false));
    usage.testCreated();
    usage.run('manual', 'pass');
    expect((await usage.settings()).pending).toEqual({ testsCreated: 0, runs: { manual: 0 }, runsPassed: 0, runsFailed: 0 });
  });

  it('waits until the first-launch steps are done', async () => {
    at('/welcome');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
    cleanup();
    at('/setup');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
  });

  it('blocks nothing and takes no focus, and counts as seen once shown (DES-10)', async () => {
    at('/');
    await screen.findByText(NOTICE_TEXT);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(document.body);
    await waitFor(async () => expect((await usage.settings()).noticeSeen).toBe(true));
    expect((await usage.settings()).enabled).toBe(true);
  });
});

describe('Settings → Privacy', () => {
  it('shows what is waiting and turns sharing off and on', async () => {
    usage.testCreated();
    usage.run('manual', 'pass');
    usage.run('manual', 'fail');
    render(<PrivacySection />);
    const sw = await screen.findByRole('switch', { name: 'Share anonymous usage counts' });
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('usage-pending').textContent).toBe('Waiting to be sent: 1 test created, 2 runs (1 passed, 1 failed)');
    expect(screen.getByText(/BREAKPATCH_NO_USAGE=1/)).toBeInTheDocument();
    expect(screen.getByText(/Test names, addresses, steps, screenshots/)).toBeInTheDocument();

    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'false'));
    expect(screen.queryByTestId('usage-pending')).not.toBeInTheDocument();
    expect((await usage.settings()).pending).toMatchObject({ testsCreated: 0 });

    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute('aria-checked', 'true'));
    expect(screen.getByTestId('usage-pending').textContent).toBe('Waiting to be sent: Nothing yet.');
  });

  it('words the waiting counts plainly', () => {
    expect(pendingLine({})).toBe('Nothing yet.');
    expect(pendingLine({ testsCreated: 1 })).toBe('1 test created, no runs');
    expect(pendingLine({ testsCreated: 2, runs: { manual: 1, ci: 2 }, runsPassed: 3, runsFailed: 0 })).toBe('2 tests created, 3 runs (3 passed, 0 failed)');
  });
});

describe('Team', () => {
  it('shows no notice and no switch: the counts go with the licence check', async () => {
    ed.edition.name = 'team';
    at('/');
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText(NOTICE_TEXT)).not.toBeInTheDocument();
    cleanup();
    render(<PrivacySection />);
    expect(await screen.findByText(/sends usage counts with the licence check/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});

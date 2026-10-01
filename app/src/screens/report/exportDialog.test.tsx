// Export (issue #43): the dialog, the screenshots through the engine, the files and printing.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run, Step } from '../../data/types';
import { ToastProvider } from '../../components/ui';
import { buildView } from '../../lib/report';
import { exportFile, fileStem, reportInput, withImages, type ExportTest } from '../../lib/report/collect';
import { PRINT_ID, printReport, removePrinted } from '../../lib/report/print';

const saved = vi.hoisted(() => ({ calls: [] as { name: string; text: string; opts: unknown }[] }));
vi.mock('../../platform', async orig => ({
  ...(await orig<typeof import('../../platform')>()),
  saveTextFile: async (name: string, text: string, opts: unknown) => { saved.calls.push({ name, text, opts }); return true; },
}));

const { ExportDialog } = await import('./ExportDialog');

const STEPS: Step[] = [
  { id: 'a', action: 'click', label: 'Click Save', target: 'Save button' },
  { id: 'g', action: 'group', label: 'Log in', steps: [{ id: 'g1', action: 'click', label: 'Click Next', target: 'Next button' }] },
];
const RUN: Run = {
  id: 'r1', appId: 'web', testId: 't1', testName: 'Edit profile', testVersion: 2, startedBy: { uid: 'u', name: 'Maria', email: 'm@x' },
  machine: 'Mac', source: 'desktop', startedAt: Date.UTC(2026, 8, 24, 14), durationMs: 5000, result: 'fail', healedCount: 1,
  steps: [
    { stepId: 'a', result: 'healed', oldAt: [1, 1], newAt: [2, 2], screenshotPath: '/shots/r1/001-a.png' },
    { stepId: 'g', result: 'failed', reason: 'targetNotFound', screenshotPath: '/shots/r1/002-g1.png' },
    { stepId: 'g1', result: 'failed', reason: 'targetNotFound', screenshotPath: '/shots/r1/002-g1.png' },
  ],
};
const TEST: ExportTest = { appName: 'Web', name: 'Edit profile', steps: STEPS, run: RUN, viewport: { width: 1280 } };
const IMG = (w: number) => ({ src: `data:image/webp;base64,${'A'.repeat(8)}`, width: w, height: 10, bytes: 6 });

beforeEach(() => { saved.calls = []; });
afterEach(() => { cleanup(); removePrinted(); });

describe('screenshots', () => {
  it('asks the engine for each one once, full size for the failed step and small for the rest, never for a card', async () => {
    const reportImages = vi.fn(async (items: { size: string }[]) => items.map(i => IMG(i.size === 'full' ? 1280 : 480)));
    const steps = await withImages(TEST, { reportImages });
    expect(reportImages).toHaveBeenCalledWith([{ path: '/shots/r1/001-a.png', size: 'small' }, { path: '/shots/r1/002-g1.png', size: 'full' }], 1280);
    expect(steps.map(s => s.image?.width)).toEqual([480, undefined, 1280]);
  });

  it('goes without them when the engine can\'t give them, or when they are left out', async () => {
    expect((await withImages(TEST, {})).every(s => !('image' in s))).toBe(true);
    expect((await withImages(TEST, { reportImages: async () => { throw new Error('gone'); } })).every(s => !('image' in s))).toBe(true);
    const reportImages = vi.fn(async () => [IMG(1)]);
    const input = await reportInput({ kind: 'run', name: 'Edit profile', tests: [TEST], screenshots: false, engine: { reportImages } });
    expect(reportImages).not.toHaveBeenCalled();
    expect(input.screenshots).toBe(false);
  });
});

describe('files', () => {
  it('are named from the heading and the day', () => {
    expect(fileStem('Café: créer un projet!', Date.UTC(2026, 8, 24, 12))).toBe('cafe-creer-un-projet-2026-09-24');
    expect(fileStem('***', Date.UTC(2026, 8, 24, 12))).toBe('breakpatch-report-2026-09-24');
  });

  it('are HTML or JUnit XML', async () => {
    const view = buildView(await reportInput({ kind: 'run', name: 'Edit profile', tests: [TEST], screenshots: true, now: RUN.startedAt }));
    const html = exportFile(view, 'html', RUN.startedAt), xml = exportFile(view, 'junit', RUN.startedAt);
    expect(html.name).toBe('edit-profile-2026-09-24.html');
    expect(html.text).toContain('<title>Edit profile · Failed · Breakpatch</title>');
    expect(xml.name).toBe('edit-profile-2026-09-24.junit.xml');
    expect(xml.text).toContain('<failure message="Step 2.1: Click Next: Couldn&apos;t find the Next button" type="targetNotFound">');
  });
});

describe('printing', () => {
  it('puts the report in the page, hidden on screen and the only thing printed, until it is removed', async () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const view = buildView(await reportInput({ kind: 'run', name: 'Edit profile', tests: [TEST], screenshots: false }));
    const { reportHtml } = await import('../../lib/report');
    await printReport(reportHtml(view));
    expect(print).toHaveBeenCalled();
    const holder = document.getElementById(PRINT_ID)!;
    expect(holder.querySelector('.bpr h1')?.textContent).toBe('Edit profile');
    expect(holder.querySelector('script')).toBeNull();
    expect(document.getElementById(`${PRINT_ID}-style`)?.textContent).toContain(`body > *:not(#${PRINT_ID})`);
    removePrinted();
    expect(document.getElementById(PRINT_ID)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('the dialog', () => {
  const open = (load = vi.fn(async (shots: boolean) => reportInput({ kind: 'run', name: 'Edit profile', tests: [TEST], screenshots: shots }))) => {
    const onClose = vi.fn();
    render(<ToastProvider><ExportDialog open onClose={onClose} what="this run" load={load} /></ToastProvider>);
    return { load, onClose };
  };

  it('says screenshots can show personal data, and can leave them out', async () => {
    const { load, onClose } = open();
    expect(screen.getByRole('note').textContent).toMatch(/personal data/);
    fireEvent.click(screen.getByRole('switch', { name: 'Include screenshots' }));
    expect(screen.queryByRole('note')).toBeNull();                 // only while they're included
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(load).toHaveBeenCalledWith(false);
    expect(saved.calls[0].name).toMatch(/^edit-profile-.*\.html$/);
    expect(saved.calls[0].opts).toMatchObject({ type: 'text/html' });
  });

  it('saves JUnit XML without asking about screenshots', async () => {
    const { load, onClose } = open();
    fireEvent.click(screen.getByLabelText(/JUnit XML/));
    // The switch stays, turned off, so the dialog keeps its height.
    expect(screen.getByRole('switch', { name: 'Include screenshots' })).toBeDisabled();
    expect(screen.getByText('JUnit XML has no screenshots.')).toBeInTheDocument();
    expect(screen.queryByRole('note')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(load).toHaveBeenCalledWith(false);
    expect(saved.calls[0].text).toContain('<testsuites name="Edit profile"');
  });
});

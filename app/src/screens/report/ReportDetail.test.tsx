import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Run, Step } from '../../data/types';
import { edition } from '../../edition';
import { ReportDetail } from './ReportDetail';

const step: Step = { id: 's2', action: 'click', label: 'Click Done', target: 'Done button' };
const run: Run = {
  id: 'run-1', appId: 'web', testId: 't', testName: 'Create a project', testVersion: 3, startedBy: { uid: 'u', name: 'Ana', email: 'a@x' },
  machine: 'MacBook', source: 'desktop', startedAt: Date.UTC(2026, 8, 24, 10), durationMs: 1000, result: 'fail', healedCount: 0,
  steps: [{ stepId: 's1', result: 'passed' }, { stepId: 's2', result: 'failed', reason: 'targetNotFound' }],
};

// LiveView measures itself; jsdom has no ResizeObserver.
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the report of a failed step', () => {
  it('copies the write-up as Markdown, in every edition', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MemoryRouter><ReportDetail run={run} test={undefined} steps={[{ id: 's1', action: 'navigate', label: 'Open the page' }, step]} step={step}
      stepRun={run.steps[1]} number="2" appName="Web app" /></MemoryRouter>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' })); });
    const text = (writeText.mock.calls[0] as unknown as [string])[0];
    expect(text.startsWith("## Create a project: step 2 Click Done failed: couldn't find the Done button\n")).toBe(true);
    expect(text).toContain('2. Click Done ← failed here');
    // Community has no Create issue.
    if (edition.name === 'community') expect(screen.queryByRole('button', { name: /Create issue/ })).toBeNull();
  });
});

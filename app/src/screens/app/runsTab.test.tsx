// The Runs tab while older runs aren't loaded (DES2-14): the count says "Latest", and a filter
// says it only looks at those.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { App, Run } from '../../data/types';
import { RunsTab } from './RunsTab';

afterEach(cleanup);
const app = { id: 'web', name: 'Web', baseUrl: 'https://x', defaultViewport: { width: 1, height: 1, dpr: 1 } } as App;
const run = (i: number, result: Run['result'] = 'pass'): Run => ({
  id: `r${i}`, appId: 'web', testId: `t${i % 2}`, testName: `Test ${i % 2}`, testVersion: 1, startedBy: { uid: 'u', name: 'Ana', email: 'a@x' },
  machine: 'Mac', source: 'desktop', startedAt: Date.now() - i * 60_000, durationMs: 1000, result, healedCount: 0, steps: [],
});

describe('the Runs tab', () => {
  it('says "Latest 20 runs" while there are older ones, and that a filter looks at those only', () => {
    const runs = Array.from({ length: 20 }, (_, i) => run(i, i === 3 ? 'fail' : 'pass'));
    const more = vi.fn();
    render(<MemoryRouter><RunsTab app={app} runs={runs} more={more} /></MemoryRouter>);
    expect(screen.getByText('Latest 20 runs')).toBeInTheDocument();
    expect(screen.queryByText(/look at the latest/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Result/ }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^Failed/ }));
    expect(screen.getByText('Latest 20 runs · 1 shown')).toBeInTheDocument();
    expect(screen.getByText("The filters look at the latest 20 runs only. Older runs aren't included until you show them.")).toBeInTheDocument();
  });

  it('counts them all when there are no older ones', () => {
    render(<MemoryRouter><RunsTab app={app} runs={[run(1), run(2)]} /></MemoryRouter>);
    expect(screen.getByText('Last 7 days · 2 runs')).toBeInTheDocument();
  });
});

// Lists that grow for ever take a limit (Backend `limit`, issue #30 in the Team repo): the demo and
// local backends cut them, and usePagedLive asks for a page more each time.
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { upTo } from './backend';
import { DemoBackend } from './demo/demoBackend';
import { usePagedLive } from './hooks';
import type { Run } from './types';
import { useSession } from '../state/session';

afterEach(() => cleanup());

describe('paging', () => {
  it('upTo takes the newest n, or all without a limit', () => {
    expect(upTo([3, 2, 1], 2)).toEqual([3, 2]);
    expect(upTo([3, 2, 1], undefined)).toEqual([3, 2, 1]);
    expect(upTo([3, 2, 1], 0)).toEqual([]);
  });

  it('the demo backend gives at most the limit, newest first', async () => {
    const b = new DemoBackend({ signedIn: true, delayMs: 0 });
    const all = await new Promise<Run[]>(r => { const off = b.runs('webapp', v => { off(); r(v); }); });
    const two = await new Promise<Run[]>(r => { const off = b.runs('webapp', v => { off(); r(v); }, 2); });
    expect(all.length).toBeGreaterThan(2);
    expect(two).toEqual(all.slice(0, 2));
  });

  it('usePagedLive shows a page, then a page more, and says when there may be more', async () => {
    const backend = new DemoBackend({ signedIn: true, delayMs: 0 });
    useSession.setState({ backend });
    const all = await new Promise<Run[]>(r => { const off = backend.runs('webapp', v => { off(); r(v); }); });
    const { result } = renderHook(() => usePagedLive<Run>((b, l, n) => b.runs('webapp', l, n), ['webapp'], 2));
    await waitFor(() => expect(result.current.data).toHaveLength(2));
    expect(result.current.hasMore).toBe(true);
    act(() => result.current.more());
    await waitFor(() => expect(result.current.data).toHaveLength(Math.min(4, all.length)));
    act(() => { for (let i = 0; i < all.length; i++) result.current.more(); });
    await waitFor(() => expect(result.current.data).toHaveLength(all.length));
    expect(result.current.hasMore).toBe(false);
  });
});

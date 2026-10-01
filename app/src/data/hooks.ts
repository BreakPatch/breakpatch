import { useEffect, useRef, useState } from 'react';
import type { Backend, Limit, Listener, Unsubscribe } from './backend';
import { useSession } from '../state/session';

/** The connected backend. Only call below the signed-in part of the app. */
export function useBackend(): Backend {
  const b = useSession(s => s.backend);
  if (!b) throw new Error('No workspace connected');
  return b;
}

export interface Live<T> { data: T | undefined; loading: boolean; slow: boolean }

/**
 * Subscribes to a backend listener. `deps` re-subscribe. `slow` turns true after 8 s
 * without data ("Still loading", ui-requirements §5.18).
 */
export function useLive<T>(subscribe: (b: Backend, l: Listener<T>) => Unsubscribe, deps: unknown[]): Live<T> {
  const backend = useBackend();
  const [data, setData] = useState<T | undefined>(undefined);
  const [slow, setSlow] = useState(false);
  const sub = useRef(subscribe); sub.current = subscribe;
  useEffect(() => {
    setData(undefined); setSlow(false);
    const timer = setTimeout(() => setSlow(true), 8000);
    const off = sub.current(backend, v => { clearTimeout(timer); setSlow(false); setData(v); });
    return () => { clearTimeout(timer); off(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, ...deps]);
  return { data, loading: data === undefined, slow };
}

/** How many runs, versions or suite runs a list shows at first, and how many more "Show more" adds. */
export const PAGE = 20;

export interface PagedLive<T> extends Live<T[]> {
  /** There may be more than shown (the list is as long as asked for). */
  hasMore: boolean;
  /** Shows `page` more. */
  more(): void;
}

/**
 * useLive for a list that grows for ever (Backend `limit`): subscribes for the first `page`, and
 * for `page` more each time `more()` is called. Keeps showing the shorter list while the longer
 * one loads. `deps` changes start again from the first page.
 */
export function usePagedLive<T>(subscribe: (b: Backend, l: Listener<T[]>, limit: Limit) => Unsubscribe, deps: unknown[], page = PAGE): PagedLive<T> {
  const [limit, setLimit] = useState(page);
  const key = JSON.stringify(deps);
  const [shownKey, setShownKey] = useState(key);
  if (shownKey !== key) { setShownKey(key); setLimit(page); }
  const live = useLive<T[]>((b, l) => subscribe(b, l, limit), [...deps, limit]);
  const last = useRef<{ key: string; data: T[] } | null>(null);
  if (live.data) last.current = { key, data: live.data };
  const data = live.data ?? (last.current?.key === key ? last.current.data : undefined);
  return {
    data, loading: data === undefined, slow: live.slow,
    hasMore: !!data && data.length >= limit,
    more: () => setLimit(n => n + page),
  };
}

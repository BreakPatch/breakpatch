import { useEffect, useRef, useState } from 'react';
import type { Backend, Listener, Unsubscribe } from './backend';
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

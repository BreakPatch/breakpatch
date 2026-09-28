import { useEffect, useState } from 'react';

/** Milliseconds since `from`, ticking while `on`. */
export function useElapsed(from: number | undefined, on: boolean): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [on]);
  return from ? Math.max(0, now - from) : 0;
}

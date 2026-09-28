import { useEffect } from 'react';
import { useSession } from './session';

/** Applies Dark / Light / Match macOS straight away (Settings → Appearance). */
export function useApplyTheme() {
  const theme = useSession(s => s.prefs.theme);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      const t = theme === 'system' ? (mq.matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    if (theme !== 'system') return;
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

import type { KeyboardEvent } from 'react';
import { useSession, type Theme } from '../../../state/session';
import { Section } from './common';

const OPTIONS: { value: Theme; t: string; d: string; pv: ('dark' | 'light')[] }[] = [
  { value: 'dark', t: 'Dark', d: 'Default', pv: ['dark'] },
  { value: 'light', t: 'Light', d: '', pv: ['light'] },
  { value: 'system', t: 'Match macOS', d: 'Follows System Settings', pv: ['dark', 'light'] },
];

function Preview({ tone }: { tone: 'dark' | 'light' }) {
  return (
    <div className={`set-pv ${tone}`}>
      <div className="set-pv-main"><div className="set-pv-bar short" /><div className="set-pv-card" /></div>
      <div className="set-pv-side"><div className="set-pv-bar accent" /><div className="set-pv-bar" /><div className="set-pv-bar" /></div>
    </div>
  );
}

export function AppearanceSection() {
  const theme = useSession(s => s.prefs.theme);
  const setPrefs = useSession(s => s.setPrefs);
  // Radio group: arrow keys move and select, as in macOS.
  const onKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const next = OPTIONS[(i + d + OPTIONS.length) % OPTIONS.length];
    setPrefs({ theme: next.value });
    (e.currentTarget.parentElement?.children[OPTIONS.indexOf(next)] as HTMLElement | undefined)?.focus();
  };
  return (
    <Section title="Appearance">
      <p className="set-lead">Changes the look straight away, for this Mac only.</p>
      <div className="set-looks" role="radiogroup" aria-label="Appearance">
        {OPTIONS.map((o, i) => (
          <button key={o.value} className="set-look" role="radio" aria-checked={theme === o.value} tabIndex={theme === o.value ? 0 : -1}
            onClick={() => setPrefs({ theme: o.value })} onKeyDown={e => onKey(e, i)}>
            <div className="set-look-pv" aria-hidden>{o.pv.map(t => <Preview key={t} tone={t} />)}</div>
            <div className="row">
              <span className="set-radio" aria-hidden />
              <div className="col" style={{ gap: 1 }}>
                <div className="set-look-t">{o.t}</div>
                <div className="set-look-d">{o.d}</div>
              </div>
            </div>
          </button>
        ))}
      </div>
      <p className="set-note">The web app you're testing always shows as it really is. Only Breakpatch's own screens change.</p>
    </Section>
  );
}

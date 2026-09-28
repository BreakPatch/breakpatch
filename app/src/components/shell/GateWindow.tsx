// The first-launch window (connect, sign in, setup): no title bar, a 520 px brand panel on the left.
import type { ReactNode } from 'react';
import { EarMark } from '../ui';
import { appVersion, isTauri } from '../../platform';
import { edition } from '../../edition';
import type { Workspace } from '../../data/types';
import './gate.css';

/** Full window with the traffic lights drawn in a browser preview and a drag strip along the top. */
export function GateWindow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={'window gi-window' + (className ? ' ' + className : '')}>
      <div className="gi-drag" data-tauri-drag-region aria-hidden />
      {!isTauri() && <div className="gi-traffic" aria-hidden><span /><span /><span /></div>}
      {children}
    </div>
  );
}

/** Left panel: ear mark, a big line (wordmark by default), the strapline and a footer line. */
export function BrandPanel({ heading, line = 'Tests your web apps by looking at them, the way a person would.', foot }: { heading?: ReactNode; line?: ReactNode; foot?: ReactNode }) {
  return (
    <aside className="gi-brand">
      <div className="gi-brand-top">
        <EarMark size={72} />
        {heading ?? <div className="gi-brand-word" aria-label="breakpatch"><b>break</b><span>patch</span></div>}
        <div className="gi-brand-line">{line}</div>
      </div>
      <div className="gi-brand-foot">{foot ?? `${edition.name === 'team' ? 'Team' : 'Open source'} · Version ${appVersion()}`}</div>
    </aside>
  );
}

/** Two columns: brand panel and the centred content. */
/** `top`: the content starts at a fixed place and grows downward (setup, whose rows gain details). */
export function GateSplit({ brand, width, children, top }: { brand?: ReactNode; width: number; children: ReactNode; top?: boolean }) {
  return (
    <GateWindow className="gi-split">
      {brand ?? <BrandPanel />}
      <main className={'gi-main' + (top ? ' top' : '')}>
        <div className="gi-content" style={{ width }}>{children}</div>
      </main>
    </GateWindow>
  );
}

/** Workspace logo in a circle; the first letter on an accent tint when there is no logo. */
export function WorkspaceLogo({ ws, size }: { ws: Pick<Workspace, 'name' | 'logo'>; size: number }) {
  if (ws.logo) return <img className="gi-logo" src={ws.logo} alt="" style={{ width: size, height: size }} />;
  return <span className="gi-logo gi-logo-letter" aria-hidden style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}>{ws.name.trim().charAt(0).toUpperCase() || '?'}</span>;
}

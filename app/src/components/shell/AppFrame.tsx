// The window: 52 px title bar, optional progress hairline, banners, then the screen.
// Screens render <AppFrame> themselves and pass their title and actions.
import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Avatar, Icon, IconButton, Segmented, Wordmark } from '../ui';
import { isTauri } from '../../platform';
import { useSession } from '../../state/session';
import { edition } from '../../edition';
import { useFeatureStore } from '../../edition/features';
import type { NavItem } from '../../edition/types';
import { SystemBanners } from './SystemBanners';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';
import './shell.css';

/** "apps", "suites", or an edition's nav item (Team: "runner"). */
export type TopNavKey = string;

const BASE_NAV: NavItem[] = [{ value: 'apps', label: 'Apps', path: '/', order: 10 }, { value: 'suites', label: 'Suites', path: '/suites', order: 20 }];
const NAV: NavItem[] = [...BASE_NAV, ...edition.nav].sort((a, b) => a.order - b.order);

const Banner = edition.slots.banner;

/**
 * Top-nav items with their dots. The list is fixed at build time, so the dot hooks always run in
 * the same order; items whose feature is off are left out after.
 */
function useNavItems(enabled: boolean) {
  const features = useFeatureStore(s => s.features);
  return NAV.map(n => ({ value: n.value, label: n.label, dot: n.useDot?.(enabled), on: !n.feature || features[n.feature] }))
    .filter(n => n.on).map(({ on: _on, ...n }) => n);
}

export interface AppFrameProps {
  /** Top-level screens show the Apps · Suites (· Local runner in Team) switch. */
  nav?: TopNavKey;
  /** Screens below the top level show a back arrow, a breadcrumb and a title. */
  back?: string | (() => void);
  crumb?: ReactNode;
  title?: ReactNode;
  /** Title-bar actions, right-aligned before the avatar. */
  actions?: ReactNode;
  /** 3 px hairline under the title bar (Run/Report). 0..1 and a tone. */
  progress?: { value: number; tone: 'running' | 'passed' | 'failed' };
  /** Extra banners under the system ones. */
  banners?: ReactNode;
  /** Hide the avatar, or the Settings button in Community (setup, runner mode). */
  hideAvatar?: boolean;
  children: ReactNode;
}

export function AppFrame({ nav, back, crumb, title, actions, progress, banners, hideAvatar, children }: AppFrameProps) {
  const navigate = useNavigate();
  const user = useSession(s => s.user);
  const items = useNavItems(!!nav);
  const onSettings = useLocation().pathname.startsWith('/settings');
  useShortcuts(!hideAvatar);
  const goBack = () => (typeof back === 'function' ? back() : back ? navigate(back) : navigate(-1));

  return (
    <div className="window">
      <header className="titlebar" data-tauri-drag-region>
        <TrafficLights />
        <Wordmark size={17} />
        {nav && <WorkspaceSwitcher />}
        {nav && (
          <Segmented<TopNavKey> label="Main" value={nav} onChange={v => navigate(NAV.find(n => n.value === v)?.path ?? '/')} items={items} />
        )}
        {!nav && (back || title) && (
          <>
            <div className="titlebar-sep" aria-hidden />
            {back && <button className="titlebar-back" onClick={goBack} aria-label="Back"><Icon name="arrow_back" size={20} /></button>}
            <div className="titlebar-title" data-tauri-drag-region>
              {crumb && <div className="titlebar-crumb">{crumb}</div>}
              {title && <h1>{title}</h1>}
            </div>
          </>
        )}
        <div className="grow" data-tauri-drag-region />
        {actions && <div className="titlebar-actions">{actions}</div>}
        {/* One person on one Mac (Community) has no account to show: a Settings button instead. */}
        {!hideAvatar && (edition.name === 'team'
          ? user && <Avatar name={user.name} onClick={() => navigate('/settings')} title="Settings" />
          : <IconButton icon="settings" label="Settings" onClick={() => navigate('/settings')} aria-keyshortcuts="Meta+Comma"
              aria-current={onSettings ? 'page' : undefined} />)}
      </header>
      {progress && <div className={`hairline ${progress.tone}`} role="progressbar" aria-label="Run progress" aria-valuenow={Math.round(progress.value * 100)}><div style={{ width: `${progress.value * 100}%` }} /></div>}
      <SystemBanners />
      {Banner && <Banner />}
      {banners}
      <main className="window-body">{children}</main>
    </div>
  );
}

/** Native traffic lights in the desktop app (overlay title bar); drawn in a browser preview. */
function TrafficLights() {
  if (isTauri()) return <div className="traffic-space" data-tauri-drag-region />;
  return <div className="traffic" aria-hidden><span style={{ background: '#FF5F57' }} /><span style={{ background: '#FEBC2E' }} /><span style={{ background: '#28C840' }} /></div>;
}

/**
 * The Mac shortcuts people expect in any app window: ⌘, opens Settings, ⌘F goes to the screen's
 * search box, ⌘N presses the screen's "new" button (a title-bar button marked
 * `aria-keyshortcuts="Meta+N"`). Nothing happens while a dialog is open, and ⌘, is off where the
 * Settings button is hidden (setup, runner mode).
 */
function useShortcuts(settings: boolean) {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = e.key.toLowerCase();
      if (key === ',' && settings) { e.preventDefault(); if (!location.hash.startsWith('#/settings')) navigate('/settings'); }
      else if (key === 'f') {
        const box = document.querySelector<HTMLInputElement>('.window-body .cm-search input, .window-body input[type="search"]');
        if (box) { e.preventDefault(); box.focus(); box.select(); }
      } else if (key === 'n') {
        const btn = document.querySelector<HTMLButtonElement>('.titlebar [aria-keyshortcuts="Meta+N"]:not(:disabled)');
        if (btn) { e.preventDefault(); btn.click(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, settings]);
}

/** Scrolls the window body to the top on navigation. */
export function useScrollTop() {
  const loc = useLocation();
  useEffect(() => { document.querySelector('.window-body')?.scrollTo(0, 0); }, [loc.pathname]);
}

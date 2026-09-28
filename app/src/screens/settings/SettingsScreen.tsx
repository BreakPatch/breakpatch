// Settings: sidebar of sections, content max 780 px (README "5 · Settings and system").
// Community has Tests folder (while one is open), AI assistant, Screen checks, Saved secrets,
// Appearance, Privacy and About; the edition adds its own (Team: Account, Workspace, Members, Automatic fixing, Local
// runner) through edition.settings. It opens on the first section there is.
import { Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AppFrame } from '../../components/shell/AppFrame';
import { Icon } from '../../components/ui';
import { edition, type SettingsSection } from '../../edition';
import { AiSection } from './sections/AiSection';
import { SecretsSection } from './sections/SecretsSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { AboutSection } from './sections/AboutSection';
import { PrivacySection } from './sections/PrivacySection';
import { FolderSection } from './sections/FolderSection';
import { ScreenChecksSection } from './sections/ScreenChecksSection';
import { NotificationsSection } from './sections/NotificationsSection';
import { useSession } from '../../state/session';
import { useFeatureStore } from '../../edition/features';
import './settings.css';

const OPEN: SettingsSection[] = [
  { key: 'folder', icon: 'folder', label: 'Tests folder', order: 10, element: FolderSection },
  { key: 'ai', icon: 'auto_awesome', label: 'AI assistant', order: 40, element: AiSection },
  { key: 'checks', icon: 'devices', label: 'Screen checks', order: 55, element: ScreenChecksSection },
  { key: 'secrets', icon: 'key', label: 'Saved secrets', order: 60, element: SecretsSection },
  { key: 'notifications', icon: 'message', label: 'Notifications', order: 70, element: NotificationsSection },
  { key: 'appearance', icon: 'contrast', label: 'Appearance', order: 80, element: AppearanceSection },
  { key: 'privacy', icon: 'shield', label: 'Privacy', order: 85, element: PrivacySection },
  { key: 'about', icon: 'info', label: 'About', order: 90, element: AboutSection },
];

const ALL = [...OPEN, ...edition.settings].sort((a, b) => a.order - b.order);

/** Section key → the section it belongs to in the sidebar and what to show. */
const PAGES = new Map(ALL.flatMap(s => [
  [s.key, { owner: s.key, Page: s.element }] as const,
  ...Object.entries(s.subPages ?? {}).map(([k, Page]) => [k, { owner: s.key, Page }] as const),
]));

export default function SettingsScreen() {
  // Tests folder only while one is open (not with the demo or a team workspace).
  const hasFolder = useSession(s => !!s.local);
  // An edition's section whose feature is off (e.g. Local runner without a licence) is hidden.
  const features = useFeatureStore(s => s.features);
  // Every section's own hook, called in the same order on every render.
  const visible = ALL.map(s => s.useVisible?.() ?? true);
  const NAV = ALL.filter((s, i) => visible[i] && (hasFolder || s.key !== 'folder') && (!s.feature || features[s.feature]));
  const { section = NAV[0].key } = useParams();
  const navigate = useNavigate();
  const loc = useLocation();
  const page = NAV.some(n => n.key === PAGES.get(section)?.owner) ? PAGES.get(section) : undefined;
  if (!page) return <Navigate to={`/settings/${NAV[0].key}`} replace />;
  const { owner, Page } = page;
  // Section switches replace the history entry, so the back arrow leaves Settings in one step.
  const back = () => (loc.key === 'default' ? navigate('/') : navigate(-1));

  return (
    <AppFrame back={back} title="Settings">
      <div className="set-layout">
        <nav className="set-side" aria-label="Settings">
          {NAV.map(n => (
            <button key={n.key} className="set-nav" aria-current={n.key === owner ? 'page' : undefined}
              onClick={() => navigate(`/settings/${n.key}`, { replace: true })}>
              <Icon name={n.icon} />{n.label}
            </button>
          ))}
        </nav>
        <div className="set-main" key={section}><Page /></div>
      </div>
    </AppFrame>
  );
}

// First-use checklist straight after setup (ui-requirements §5.18).
import { Button, Icon } from '../../components/ui';

interface Item { icon: string; title: string; text: string; state: 'done' | 'next' | 'later'; action?: { label: string; onClick: () => void } }

export function FirstUse({ workspace, firstName, hasApp, onAddApp, onNewTest }: {
  /** The team workspace's name; undefined for a tests folder on this Mac. */
  workspace?: string; firstName: string; hasApp: boolean; onAddApp: () => void; onNewTest: () => void;
}) {
  const items: Item[] = [
    { icon: 'check', title: workspace ? 'Workspace connected and set up' : 'Tests folder chosen and set up', text: 'Test browser and AI assistant are ready.', state: 'done' },
    hasApp
      ? { icon: 'check', title: 'Add the app you want to test', text: 'A name and its web address.', state: 'done' }
      : { icon: 'add', title: 'Add the app you want to test', text: 'A name and its web address.', state: 'next', action: { label: 'Add app', onClick: onAddApp } },
    { icon: 'radio_button_checked', title: 'Record your first test', text: 'Click through something simple, like logging in.', state: hasApp ? 'next' : 'later', action: hasApp ? { label: 'New test', onClick: onNewTest } : undefined },
    { icon: 'play_arrow', title: 'Run it', text: 'See every step checked. Then break something and watch it catch it.', state: 'later' },
  ];
  return (
    <div className="home-first">
      <div className="col" style={{ gap: 8 }}>
        <div className="home-first-kicker">{workspace ? `Welcome to the ${workspace} workspace` : 'Welcome to Breakpatch'}{firstName ? `, ${firstName}` : ''}.</div>
        <h2 className="home-first-title">Your first test takes about 5 minutes.</h2>
      </div>
      <ol className="home-first-list">
        {items.map(it => (
          <li key={it.title} className={`home-first-item ${it.state}`}>
            <span className="home-first-disc"><Icon name={it.icon} size={20} /></span>
            <div className="grow col" style={{ gap: 2 }}>
              <div className="home-first-item-title">{it.title}<span className="sr-only">{it.state === 'done' ? ' (done)' : it.state === 'next' ? ' (next)' : ''}</span></div>
              <div className="home-first-item-text">{it.text}</div>
            </div>
            {it.action && <Button kind="primary" onClick={it.action.onClick}>{it.action.label}</Button>}
          </li>
        ))}
      </ol>
      <div className="home-first-hint">An app is just a name and a web address, like "Web app · app.example.com".</div>
    </div>
  );
}

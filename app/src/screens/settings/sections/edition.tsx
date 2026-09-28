// Settings → About: which edition this copy is, and whether its engine agrees (docs/editions.md).
// The app's edition is decided at build time (src/edition); the engine's comes from `system.info`.
// A release bundles both, so they only differ in a broken build, e.g. a Team app whose sidecar
// was built without the Team engine (then moved buttons can't be fixed automatically).
import { Icon } from '../../../components/ui';
import type { Edition } from '../../../edition';
import type { SystemInfo } from '../../../engine';

type EditionName = Edition['name'];

export function editionLabel(name: EditionName): 'Community' | 'Team' {
  return name === 'team' ? 'Team' : 'Community';
}

/** The mismatch to warn about, or null when the engine agrees (or hasn't answered yet). */
export function editionMismatch(app: EditionName, engine: SystemInfo['edition'] | undefined): string | null {
  if (!engine || engine === app) return null;
  return app === 'team'
    ? 'This is the Team app, but its engine is the Community engine: buttons that moved can’t be fixed automatically. Reinstall Breakpatch.'
    : 'This is the Community app, but its engine is the Team engine. Reinstall Breakpatch.';
}

export function EditionMismatch({ app, engine }: { app: EditionName; engine: SystemInfo['edition'] | undefined }) {
  const problem = editionMismatch(app, engine);
  if (!problem) return null;
  return (
    <div className="set-info set-folder-error" role="alert">
      <Icon name="warning" />
      <div>
        <strong>The app and its engine don’t match</strong> (app {editionLabel(app)}, engine {editionLabel(engine!)}). {problem}
      </div>
    </div>
  );
}

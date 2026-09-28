// "Allow saved secrets on this site?": asked once for saved secrets that have no sites yet
// (lib/secretSites.ts). They were saved before Breakpatch tied each secret to the sites it may be
// typed on.
import { Button, Dialog } from '../ui';
import { useSitesQuestion } from '../../lib/secretSites';
import { siteName } from '../../lib/sites';

export function SecretSitesPrompt() {
  const q = useSitesQuestion(s => s.question);
  if (!q) return null;
  const site = siteName(q.origin);
  const one = q.names.length === 1;
  const list = q.names.join(', ');
  return (
    <Dialog open onClose={() => q.answer(false)} title={`Allow ${one ? 'this saved secret' : 'these saved secrets'} on ${site}?`} icon="key"
      actions={<>
        <Button kind="ghost" onClick={() => q.answer(false)}>Not now</Button>
        <Button kind="primary" onClick={() => q.answer(true)}>Allow on {site}</Button>
      </>}>
      <p className="set-lead" style={{ margin: 0 }}>
        Breakpatch now types each saved secret only on the sites you allow. <span className="mono">{list}</span> {one ? "doesn't" : "don't"} have
        any sites yet. Allow {one ? 'it' : 'them'} on <strong>{site}</strong>, the site of this test's app?
      </p>
      <p className="set-note" style={{ marginBottom: 0 }}>You can add or change sites in Settings, Saved secrets. Without one, the test stops before typing {one ? 'it' : 'them'}.</p>
    </Dialog>
  );
}

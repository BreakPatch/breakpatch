// "Write a test from a story" (Breakpatch Team, roadmap #10): the person pastes a short user story
// or acceptance criteria and picks the saved secrets it may type; the engine proposes the steps
// (`record.plan`), and the recorder goes through them one at a time (PlanCard, useRecorder).
import { useEffect, useRef, useState } from 'react';
import { Button, Checkbox, Dialog, Icon, TextArea } from '../../components/ui';
import { getEngine, type Plan } from '../../engine';
import { secrets } from '../../platform';
import { osText } from '../../lib/osWords';

export const STORY_PLACEHOLDER = 'For example: Sign up with a new email and my password. Then I see "Account created".';

export function StoryDialog({ open, onClose, onPlan }: { open: boolean; onClose: () => void; onPlan: (p: Plan) => void }) {
  const [story, setStory] = useState('');
  const [names, setNames] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) void secrets.list().then(setNames).catch(() => setNames([]));
  }, [open]);
  // Each request's number: closing the dialog moves it on, so an answer that comes after is dropped
  // (the engine still finishes it; nothing is done to the page either way).
  const asked = useRef(0);
  const close = () => { asked.current++; setBusy(false); setError(null); onClose(); };

  const make = async () => {
    if (!story.trim() || busy) return;
    const mine = ++asked.current;
    setBusy(true); setError(null);
    try {
      const plan = await getEngine().plan(story.trim(), picked.filter(n => names.includes(n)));
      if (mine !== asked.current) return;
      onPlan(plan);
      setStory(''); setPicked([]);
      onClose();
    } catch (e) {
      if (mine !== asked.current) return;
      setError(e instanceof Error ? e.message : "Couldn't make steps from this story. Try again.");
    } finally { if (mine === asked.current) setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={close} title="Write a test from a story" icon="auto_awesome" width={560}
      sub="The AI assistant suggests the steps. You check each one on the page before it's added."
      actions={<>
        <Button onClick={close}>Cancel</Button>
        <Button kind="primary" icon="auto_awesome" busy={busy} disabled={!story.trim()} onClick={() => void make()}>{busy ? 'Making steps…' : 'Make steps'}</Button>
      </>}>
      <form className="col" style={{ gap: 14 }} onSubmit={e => { e.preventDefault(); void make(); }}>
        <TextArea label="Your story" value={story} rows={5} placeholder={STORY_PLACEHOLDER} autoFocus disabled={busy}
          hint="A few short sentences, one action each. Start from the page that's open now."
          onChange={e => { setStory(e.target.value); setError(null); }}
          onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void make(); } }} />
        <fieldset className="col" style={{ gap: 6, border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Saved secrets it may type</legend>
          {names.length === 0
            ? <span className="faint" style={{ fontSize: 13 }}>{osText('No saved secrets on this Mac. Steps that need a password will ask you.')}</span>
            : names.map(n => (
              <Checkbox key={n} label={n} checked={picked.includes(n)}
                onChange={on => setPicked(p => (on ? [...p, n] : p.filter(x => x !== n)))} />
            ))}
          <span className="faint" style={{ fontSize: 12 }}>Only their names go to the AI assistant, never their values.</span>
        </fieldset>
        {error && <div className="rec-plan-error" role="alert"><Icon name="error" size={18} />{error}</div>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

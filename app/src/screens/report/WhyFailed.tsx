// "Why did this fail?" under a failed step's reason in the report (Breakpatch Team, roadmap #7):
// asked on demand, the AI assistant's plain explanation, its likely cause and one suggestion,
// always marked as the AI assistant's. Shown only with the `explain` feature.
import { useState } from 'react';
import type { Explanation, Run, Step, StepRun, Viewport } from '../../data/types';
import { useSession } from '../../state/session';
import { getEngine } from '../../engine';
import { useFeature } from '../../edition';
import { Button, Icon, Spinner } from '../../components/ui';
import { canExplain, causeText, explainProblem, explainStep } from '../../lib/explain';
import { isDemo } from '../run/demo';

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; e: Explanation | null } | { kind: 'error'; message: string; retry: boolean };

/**
 * `onAnswer`: the explanation once there is one, so the report puts its suggestion with the actions
 * ("What to try"), next to the button that acts on it, instead of repeating it here.
 */
export function WhyFailed({ run, step, stepRun, viewport, onAnswer }: { run: Run; step: Step; stepRun: StepRun | undefined; viewport: Pick<Viewport, 'width' | 'height'>; onAnswer?: (e: Explanation | null) => void }) {
  const on = useFeature('explain');
  const backend = useSession(s => s.backend);
  const [state, setState] = useState<State>(stepRun?.explanation ? { kind: 'done', e: stepRun.explanation } : { kind: 'idle' });
  if (!on || !stepRun || !canExplain(stepRun, isDemo())) return null;

  const ask = async () => {
    setState({ kind: 'busy' });
    try {
      const e = await explainStep({ engine: getEngine(), backend, run, step, stepRun, viewport });
      setState({ kind: 'done', e });
      onAnswer?.(e);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setState({ kind: 'error', message: explainProblem(err), retry: code !== 'not_ready' && code !== 'not_found' });
    }
  };

  if (state.kind === 'idle') {
    return (
      <div className="rp-why-ask">
        <Button icon="auto_awesome" onClick={ask}>Why did this fail?</Button>
        <span className="rp-hint">The AI assistant compares this screen with the recording.</span>
      </div>
    );
  }
  const e = state.kind === 'done' ? state.e : null;
  const cause = e ? causeText(e) : undefined;
  return (
    <div className="rp-why" role="note" aria-label="Why did this fail?" aria-busy={state.kind === 'busy'}>
      <div className="rp-why-by"><Icon name="auto_awesome" size={16} />From the AI assistant</div>
      {state.kind === 'busy' && <div className="rp-why-text rp-why-busy"><Spinner size={16} />Looking at the screen…</div>}
      {state.kind === 'done' && e && (
        <>
          <div className="rp-why-text">{e.summary}</div>
          {cause && <div className="rp-why-facts"><div><span className="rp-why-k">Likely cause</span>{cause}</div></div>}
        </>
      )}
      {state.kind === 'done' && !e && (
        <div className="rp-why-text">The AI assistant couldn't tell what changed. Compare the two screens below.
          <Button size="sm" kind="ghost" onClick={ask}>Try again</Button></div>
      )}
      {state.kind === 'error' && (
        <div className="rp-why-text">{state.message}{state.retry && <Button size="sm" kind="ghost" onClick={ask}>Try again</Button>}</div>
      )}
    </div>
  );
}

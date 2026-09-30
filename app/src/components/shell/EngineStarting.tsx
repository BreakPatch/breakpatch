// "Starting Breakpatch…" from the moment the app opens until the engine first answers. The
// packaged engine unpacks itself before it can answer: a few seconds, longer on a Mac's first
// start (of this version: state/system.ts firstEngineStart), which is the only time it says so.
// Floats over the window (it never moves anything); the setup screen says it in its list.
import { useLocation } from 'react-router-dom';
import { useSystem } from '../../state/system';
import { Spinner } from '../ui';

export const STARTING_TEXT = 'Starting Breakpatch…';
export const FIRST_STARTING_TEXT = 'Starting Breakpatch… The first start takes a little longer.';
export const startingText = (first: boolean) => (first ? FIRST_STARTING_TEXT : STARTING_TEXT);

export function EngineStarting() {
  const ready = useSystem(s => s.engineReady);
  const first = useSystem(s => s.firstEngineStart);
  const { pathname } = useLocation();
  if (ready || pathname === '/setup') return null;
  return <div className="engine-starting" role="status"><Spinner size={16} />{startingText(first)}</div>;
}

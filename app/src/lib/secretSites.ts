// Saved secrets from before sites existed have none, so the engine types them nowhere. The
// first time a run or a recording uses such a secret, the app asks once to allow the test app's
// site for it (SecretSitesPrompt, mounted in App). "Not now" is remembered too: the run then stops
// at that step and says to add a site in Settings, Saved secrets.
import { create } from 'zustand';
import { secrets } from '../platform';
import { originOf } from './sites';

export interface SitesQuestion { names: string[]; origin: string; answer: (allow: boolean) => void }

export const useSitesQuestion = create<{ question: SitesQuestion | null }>(() => ({ question: null }));

const ASKED_KEY = 'breakpatch.secretSitesAsked';

function asked(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(ASKED_KEY) ?? '[]') as string[]); } catch { return new Set(); }
}
function remember(names: string[]) {
  try { localStorage.setItem(ASKED_KEY, JSON.stringify([...new Set([...asked(), ...names])].sort())); } catch { /* storage unavailable */ }
}

/** Shows the question and waits for the answer. Only one at a time: a second one waits its turn. */
let queue: Promise<unknown> = Promise.resolve();
function ask(names: string[], origin: string): Promise<boolean> {
  const next = queue.then(() => new Promise<boolean>(resolve => {
    useSitesQuestion.setState({ question: { names, origin, answer: allow => { useSitesQuestion.setState({ question: null }); resolve(allow); } } });
  }));
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Before a run or a recorded "Write saved secret" step: for the named secrets that are on this Mac
 * but have no sites yet (and weren't asked about before), asks once to allow `appUrl`'s site.
 * Resolves when that's settled; it never throws (the engine refuses what isn't allowed anyway).
 */
export async function ensureSecretSites(names: string[], appUrl: string | undefined): Promise<void> {
  const origin = originOf(appUrl);
  if (!names.length || !origin) return;
  try {
    const info = await secrets.info();
    const seen = asked();
    const legacy = info.filter(s => names.includes(s.name) && s.origins.length === 0 && !seen.has(s.name));
    if (!legacy.length) return;
    const allow = await ask(legacy.map(s => s.name), origin);
    remember(legacy.map(s => s.name));
    if (allow) await Promise.all(legacy.map(s => secrets.setPolicy(s.name, [origin], s.runnerCanUse)));
  } catch { /* the run carries on; the engine says what's missing */ }
}

/** Tests only. */
export function forgetAskedForTests() { try { localStorage.removeItem(ASKED_KEY); } catch { /* ignore */ } }

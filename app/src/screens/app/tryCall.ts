// "Try it" for the set-up and clean-up calls: one real request, timed. It goes through the engine
// (`call.try`), never the webview's fetch: the release CSP blocks that, and the engine applies the
// same rules as a run (https, the app's own hosts, no private addresses, no redirects).
import type { HttpCall } from '../../data/types';
import type { CallReply, Engine, SecretScope } from '../../engine/engine';
import { originOf, siteName } from '../../lib/sites';
import { osText } from '../../lib/osWords';

export type Reply = { ok: true; status: number; ms: number }
  | { ok: false; status?: number; ms?: number; error: 'invalid' | 'refused' | 'redirect' | 'secret' | 'unreachable' | 'timeout' | 'status'; message?: string };

export function isHttpAddress(url: string): boolean {
  try { const u = new URL(url.trim()); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; }
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

// Parents many unrelated customers share (engine calls.py SHARED_PARENTS): the host alone counts.
const SHARED_PARENTS = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'ne.jp',
  'com.br', 'com.cn', 'com.hk', 'com.sg', 'co.in', 'co.za', 'com.mx', 'co.kr', 'com.tr', 'com.tw', 'github.io', 'gitlab.io', 'vercel.app',
  'netlify.app', 'herokuapp.com', 'web.app', 'firebaseapp.com', 'azurewebsites.net', 'cloudfront.net', 'appspot.com', 'pages.dev',
  'workers.dev', 'onrender.com', 'fly.dev', 'amplifyapp.com', 'ngrok.io', 'ngrok-free.app', 'blob.core.windows.net', 's3.amazonaws.com']);

/** The host and the parent domain whose other hosts belong to the same app (engine calls.py). */
function related(appHost: string): [string, string | null] {
  const h = appHost.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || /^[\d.]+$/.test(h) || h.includes(':') || h.startsWith('[')) return [h, null];
  const labels = h.split('.');
  if (labels.length < 3) return [h, h];
  const parent = labels.slice(1).join('.');
  return SHARED_PARENTS.has(parent) ? [h, null] : [h, parent];
}

/**
 * Why the engine will refuse this call, worked out here so the form can say so before anyone
 * presses Try it or runs the test. The engine checks again (and more: DNS, private addresses).
 */
export function callProblem(call: HttpCall, appUrl: string): string | undefined {
  const url = call.url.trim();
  if (!url) return undefined;
  if (!isHttpAddress(url)) return 'Enter a full address, starting with https://';
  const u = new URL(url);
  const app = (() => { try { return new URL(appUrl); } catch { return null; } })();
  const local = !!app && isLoopback(app.hostname);
  if (u.protocol === 'http:' && !(local && isLoopback(u.hostname))) return osText('Use https://. Plain http:// is only for an app on this Mac (localhost).');
  if (call.allowOtherHosts || !app) return undefined;
  const [own, parent] = related(app.hostname);
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host === own || (parent && (host === parent || host.endsWith('.' + parent)))) return undefined;
  const site = originOf(appUrl);
  return `This goes to ${host}, which isn't part of ${site ? siteName(site) : 'the app'}. Turn on Allow other hosts to call it.`;
}

/** The call as saved: trimmed, headers without a name left out, the "Allow other hosts" choice. */
export function cleanCall(c: HttpCall, allowOtherHosts: boolean): HttpCall {
  const headers = (c.headers ?? []).map(h => ({ ...h, name: h.name.trim() })).filter(h => h.name)
    .map(h => (h.secretRef ? { name: h.name, secretRef: h.secretRef } : { name: h.name, value: h.value ?? '' }));
  return { method: c.method, url: c.url.trim(), ...(headers.length ? { headers } : {}), ...(allowOtherHosts ? { allowOtherHosts: true } : {}) };
}

/** `scope`: where the call is tried, and the workspace's secrets it may send (lib/secretScope.ts). */
export async function tryCall(call: HttpCall, opts: { engine: Engine; appUrl: string; secrets?: Record<string, string>; scope?: SecretScope }): Promise<Reply> {
  if (!isHttpAddress(call.url)) return { ok: false, error: 'invalid' };
  let r: CallReply;
  try { r = await opts.engine.tryCall({ ...call, url: call.url.trim() }, opts.appUrl, opts.secrets ?? {}, opts.scope ?? {}); }
  catch { return { ok: false, error: 'unreachable' }; }
  if (r.ok && r.status !== undefined) return { ok: true, status: r.status, ms: r.ms ?? 0 };
  return { ok: false, status: r.status, ms: r.ms, error: r.error ?? 'unreachable', message: r.message };
}

/** "Replied 200 in 0.8 s" and friends. */
export function describeReply(r: Reply): string {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  if (r.ok) return `Replied ${r.status} in ${secs(r.ms)}`;
  if (r.error === 'status' && r.status) return `Replied ${r.status} in ${secs(r.ms ?? 0)}`;
  if (r.message) return r.message;
  if (r.status) return `Replied ${r.status} in ${secs(r.ms ?? 0)}`;
  if (r.error === 'invalid') return 'Enter a full address, starting with https://';
  if (r.error === 'timeout') return 'No reply after 15 s';
  return "Couldn't reach this address";
}

// Calls to the app's API: the set-up and clean-up calls and Call steps (issue #44). "Try it" makes
// one real request, timed. It goes through the engine (`call.try`), never the webview's fetch: the
// release CSP blocks that, and the engine applies the same rules as a run (https, the app's own
// hosts, no private addresses, no redirects). The checks here say what the engine would refuse
// before anyone presses Try it; the engine checks again (engine/PROTOCOL.md "Call steps").
import type { HttpCall, KeptValue, Step } from '../data/types';
import type { CallReply, CallStepOptions, Engine, SecretScope } from '../engine/engine';
import { originOf, siteName } from './sites';
import { osText } from './osWords';

export type Reply = { ok: true; status: number; ms: number; kept?: boolean }
  | { ok: false; status?: number; ms?: number; error: 'invalid' | 'refused' | 'redirect' | 'secret' | 'unreachable' | 'timeout' | 'status' | 'keep'; message?: string };

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

/**
 * The call as saved: trimmed, headers without a name left out, the "Allow other hosts" choice, and
 * a body as typed (a Call step's), left out when empty or for a GET.
 */
export function cleanCall(c: HttpCall, allowOtherHosts: boolean): HttpCall {
  const headers = (c.headers ?? []).map(h => ({ ...h, name: h.name.trim() })).filter(h => h.name)
    .map(h => (h.secretRef ? { name: h.name, secretRef: h.secretRef } : { name: h.name, value: h.value ?? '' }));
  const body = c.method !== 'GET' && c.body?.trim() ? c.body : undefined;
  return { method: c.method, url: c.url.trim(), ...(headers.length ? { headers } : {}), ...(body !== undefined ? { body } : {}), ...(allowOtherHosts ? { allowOtherHosts: true } : {}) };
}

/** Names of the saved secrets a call's headers use. */
export function callSecretRefs(c: HttpCall | undefined): string[] {
  return [...new Set((c?.headers ?? []).map(h => h.secretRef).filter((n): n is string => !!n))];
}

/** `scope`: where the call is tried, and the workspace's secrets it may send (lib/secretScope.ts). `step`: a Call step's own options. */
export async function tryCall(call: HttpCall, opts: { engine: Engine; appUrl: string; secrets?: Record<string, string>; scope?: SecretScope; step?: CallStepOptions }): Promise<Reply> {
  if (!isHttpAddress(call.url)) return { ok: false, error: 'invalid' };
  let r: CallReply;
  const c = { ...call, url: call.url.trim() };
  try { r = await (opts.step ? opts.engine.tryCall(c, opts.appUrl, opts.secrets ?? {}, opts.scope ?? {}, opts.step) : opts.engine.tryCall(c, opts.appUrl, opts.secrets ?? {}, opts.scope ?? {})); }
  catch { return { ok: false, error: 'unreachable' }; }
  if (r.ok && r.status !== undefined) return { ok: true, status: r.status, ms: r.ms ?? 0, ...(r.kept ? { kept: true } : {}) };
  return { ok: false, status: r.status, ms: r.ms, error: r.error ?? 'unreachable', message: r.message };
}

// ---------- A Call step's own options (engine calls.py parse_statuses, parse_path) ----------

/** The statuses a Call step passes on when it names none. */
export const DEFAULT_PASS = '2xx';
/** A Call step's wait for a reply: the default and the most, in seconds. */
export const CALL_TIMEOUT_S = 30;
export const CALL_TIMEOUT_MAX_S = 120;
/** The most a body may be, in bytes (UTF-8). */
export const BODY_MAX = 64 * 1024;
/** A kept value's name: letters, numbers and _, starting with a letter. */
export const VALUE_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

/** Why the engine would refuse these statuses that pass ("200, 201", "2xx", "200-204"), else undefined. */
export function statusProblem(text: string | undefined): string | undefined {
  const items = (text ?? '').trim().split(/[,\s]+/).filter(Boolean);
  if (items.length > 20) return 'List at most 20 statuses that pass.';
  for (const item of items) {
    const cls = /^([1-5])xx$/i.exec(item), range = /^(\d{3})(?:-(\d{3}))?$/.exec(item);
    if (!cls && !range) return 'Statuses that pass look like 200, 2xx or 200-204.';
    const lo = cls ? Number(cls[1]) * 100 : Number(range![1]);
    const hi = cls ? lo + 99 : Number(range![2] ?? range![1]);
    if (lo > hi || lo < 200 || hi > 599) return 'Statuses that pass are between 200 and 599, like 200, 2xx or 200-204.';
    if (lo <= 399 && hi >= 300) return "A redirect (3xx) can't count as a pass: calls don't follow redirects.";
  }
  return undefined;
}

/** Why the engine can't read where a kept value is ("$.code", "$.data.items[0].id"), else undefined. */
export function pathProblem(path: string): string | undefined {
  let p = path.trim();
  if (p.startsWith('$')) p = p.slice(1);
  else if (p && !p.startsWith('[') && !p.startsWith('.')) p = '.' + p;
  const part = /^(?:\.[A-Za-z_$][\w$-]*|\[\d+\]|\[["'][^"']*["']\])/;
  let n = 0;
  while (p) { const m = part.exec(p); if (!m) break; p = p.slice(m[0].length); n++; }
  return p || !n || n > 20 ? 'Write where the value is like $.code or $.data.items[0].id.' : undefined;
}

/** Why a Call step can't be saved as it is, else undefined: its call, its body, its statuses, what it keeps. */
export function callStepProblem(s: Pick<Step, 'call' | 'passStatus' | 'keep'>, appUrl: string, takenNames: string[] = []): string | undefined {
  const c = s.call;
  if (!c?.url.trim()) return 'Enter the address to call.';
  const p = callProblem(c, appUrl);
  if (p) return p;
  if (c.method === 'GET' && c.body?.trim()) return "A GET call can't have a body. Use POST, PUT, PATCH or DELETE.";
  if (c.body && new TextEncoder().encode(c.body).length > BODY_MAX) return `The body is too long: calls send at most ${BODY_MAX / 1024} KB.`;
  const st = statusProblem(s.passStatus);
  if (st) return st;
  return s.keep ? keepProblem(s.keep, takenNames) : undefined;
}

export function keepProblem(k: KeptValue, takenNames: string[] = []): string | undefined {
  const where = pathProblem(k.path);
  if (where) return where;
  if (!VALUE_NAME.test(k.name)) return 'Name the value with letters, numbers and _ only, starting with a letter.';
  if (takenNames.includes(k.name)) return 'Another Call step keeps a value with that name.';
  return undefined;
}

/** The names Call steps keep values as, in order (loops and shared steps included). */
export function keptNames(steps: Step[]): string[] {
  const out: string[] = [];
  const walk = (list: Step[]) => list.forEach(s => {
    if (s.action === 'call' && s.keep?.name && !out.includes(s.keep.name)) out.push(s.keep.name);
    // A Wait for an email step keeps what it picks out as emailCode or emailLink (Breakpatch Team).
    const picked = s.action === 'emailWait' ? (s.email?.pick === 'code' ? 'emailCode' : s.email?.pick === 'link' ? 'emailLink' : undefined) : undefined;
    if (picked && !out.includes(picked)) out.push(picked);
    if (s.steps) walk(s.steps);
  });
  walk(steps);
  return out;
}

/** "Replied 200 in 0.8 s" and friends. `timeoutS`: the wait the call had (Try it's 15 s by default). */
export function describeReply(r: Reply, timeoutS = 15): string {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  if (r.ok) return `Replied ${r.status} in ${secs(r.ms)}${r.kept ? ', and the value is there' : ''}`;
  if (r.error === 'status' && r.status) return `Replied ${r.status} in ${secs(r.ms ?? 0)}`;
  if (r.message) return r.message;
  if (r.status) return `Replied ${r.status} in ${secs(r.ms ?? 0)}`;
  if (r.error === 'invalid') return 'Enter a full address, starting with https://';
  if (r.error === 'timeout') return `No reply after ${timeoutS} s`;
  return "Couldn't reach this address";
}

/**
 * Whether steps (as stored: any shape) have a Call step, or a Write step that types a value one
 * keeps, at any depth. Apps from before Call steps can't run or edit those, so the first one saved
 * raises the tests folder's and the workspace's format (data/local/format.ts CALL_SCHEMA_VERSION).
 */
export function usesCallSteps(steps: unknown): boolean {
  if (!Array.isArray(steps)) return false;
  return steps.some(s => !!s && typeof s === 'object'
    && ((s as Step).action === 'call' || ((s as Step).action === 'write' && !!(s as Step).valueRef) || usesCallSteps((s as Step).steps)));
}

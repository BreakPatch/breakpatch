// Local macOS notifications when a run or suite finishes while the Breakpatch window is in the
// background (Settings → Notifications). They stay on this Mac: the text goes only to the local
// notification. Through tauri-plugin-notification's commands, called with the core `invoke`.
import { isTauri } from '../platform';

export interface NotifyPrefs {
  /** "Failures": on by default. */
  notifyFailures: boolean;
  /** "Every finished run": off by default. */
  notifyAll: boolean;
}
export const NOTIFY_DEFAULTS: NotifyPrefs = { notifyFailures: true, notifyAll: false };

export type Finished =
  | { kind: 'test'; name: string; result: 'pass' | 'fail'; failedAt?: { number: number | string; label: string }; path: string }
  | { kind: 'suite'; name: string; tests: number; failed: number; durationMs: number; path: string };

export interface Note { title: string; body: string; path: string }

const minutes = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`);

/** The notification for a finished run, or null when none should show. */
export function notificationFor(f: Finished, prefs: Partial<NotifyPrefs>, focused: boolean): Note | null {
  const p = { ...NOTIFY_DEFAULTS, ...prefs };
  if (focused) return null;                                            // they can see it already
  const failed = f.kind === 'test' ? f.result === 'fail' : f.failed > 0;
  if (!(p.notifyAll || (failed && p.notifyFailures))) return null;
  if (f.kind === 'test') {
    if (!failed) return { title: `${f.name} passed`, body: 'Every step passed.', path: f.path };
    return { title: `${f.name} failed`, body: f.failedAt ? `At step ${f.failedAt.number}, ${f.failedAt.label}` : 'The run stopped.', path: f.path,
    };
  }
  const summary = failed ? `${f.failed} of ${f.tests} failed` : `passed: ${f.tests} ${f.tests === 1 ? 'test' : 'tests'} in ${minutes(f.durationMs)}`;
  return { title: failed ? `${f.name} suite: ${summary}` : `${f.name} suite ${summary}`, body: failed ? 'Open the suite to see which.' : 'Every test passed.', path: f.path };
}

/** "Test2 failed at step 9, Click Close button" as one line (the title and body together). */
export const oneLine = (n: Note) => (n.title.endsWith('failed') && n.body.startsWith('At step') ? `${n.title} ${n.body.replace(/^At/, 'at')}` : `${n.title}. ${n.body}`);

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
async function tauriInvoke(): Promise<Invoke> { return (await import('@tauri-apps/api/core')).invoke as Invoke; }

export type Permission = 'granted' | 'denied' | 'prompt';

/** Whether macOS lets Breakpatch show notifications (asks the first time, when `ask`). */
export async function notifyPermission(ask: boolean): Promise<Permission> {
  if (!isTauri()) return 'denied';
  const invoke = await tauriInvoke();
  if (await invoke('plugin:notification|is_permission_granted')) return 'granted';
  if (!ask) return 'prompt';
  const got = await invoke('plugin:notification|request_permission');
  return got === 'granted' ? 'granted' : got === 'denied' ? 'denied' : 'prompt';
}

/** Where to go when the app comes forward after a notification (macOS gives no click event). */
let pending: { path: string; at: number } | null = null;
export function takePendingReport(now = Date.now()): string | null {
  const p = pending; pending = null;
  return p && now - p.at < 30 * 60_000 ? p.path : null;
}

/** Shows the notification for a finished run, if the settings and the window say so. */
export async function notifyFinished(f: Finished, prefs: Partial<NotifyPrefs>, focused = typeof document !== 'undefined' && document.hasFocus()): Promise<boolean> {
  const n = notificationFor(f, prefs, focused);
  if (!n || !isTauri()) return false;
  try {
    if ((await notifyPermission(true)) !== 'granted') return false;
    const invoke = await tauriInvoke();
    await invoke('plugin:notification|notify', { options: { title: n.title, body: n.body } });
    pending = { path: n.path, at: Date.now() };
    return true;
  } catch { return false; }
}

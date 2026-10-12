// Auto-update through the Tauri updater (spec §17). Endpoint and public key live in tauri.conf.json.
// lib/autoUpdates.ts calls checkForUpdates on its own (when the app opens, then every hour);
// Settings → About's Check for updates calls it by hand.
import { isTauri } from '../platform';
import { useSystem } from '../state/system';

type Pending = { version: string; install: () => Promise<void> };
let pending: Pending | null = null;

export type CheckResult = { state: 'upToDate' } | { state: 'ready'; version: string } | { state: 'failed'; reason: string };

/** The check going on now: a second caller (About while an automatic one runs) gets its result. */
let inflight: Promise<CheckResult> | null = null;
/** When the last check started, automatic or by hand, since the app opened. */
let lastStarted: number | null = null;

/**
 * Checks GitHub Releases for a newer version and downloads it in the background. Never two at
 * once: while one is going on, this returns that one.
 */
export function checkForUpdates(): Promise<CheckResult> {
  if (!inflight) {
    lastStarted = Date.now();
    inflight = runCheck().finally(() => { inflight = null; });
  }
  return inflight;
}

/** Whether a check is going on now. */
export function isCheckingForUpdates(): boolean { return inflight !== null; }

/** When the last check started since the app opened (null: none yet). */
export function lastCheckStarted(): number | null { return lastStarted; }

async function runCheck(): Promise<CheckResult> {
  if (!isTauri()) {
    await new Promise(r => setTimeout(r, 1200));
    noteChecked();
    return { state: 'upToDate' };
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    noteChecked();
    if (!update) return { state: 'upToDate' };
    await update.download();                        // signature is verified by the plugin
    pending = { version: update.version, install: () => update.install() };
    useSystem.getState().setUpdateReady(update.version);
    return { state: 'ready', version: update.version };
  } catch (e) {
    return { state: 'failed', reason: "Couldn't reach GitHub to check for updates." + (e instanceof Error ? ` (${e.message})` : '') };
  }
}

/** Settings → About's "Last checked": when GitHub last answered a check, on this Mac. */
const LAST_KEY = 'breakpatch.updates.lastChecked';
export function lastChecked(): number | null { try { const v = localStorage.getItem(LAST_KEY); return v ? Number(v) : null; } catch { return null; } }
function noteChecked() { try { localStorage.setItem(LAST_KEY, String(Date.now())); } catch { /* ignore */ } }

export async function restartToUpdate(): Promise<void> {
  if (!pending) return;
  await pending.install();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

/** For tests only. */
export function resetUpdatesForTests(): void { pending = null; inflight = null; lastStarted = null; }

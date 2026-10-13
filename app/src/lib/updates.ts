// Auto-update through the Tauri updater (spec §17). Endpoint and public key live in tauri.conf.json.
// lib/autoUpdates.ts calls checkForUpdates on its own (when the app opens, then every hour);
// Settings → About's Check for updates calls it by hand.
import type { Update } from '@tauri-apps/plugin-updater';
import { isTauri } from '../platform';
import { useSystem } from '../state/system';

type Pending = { version: string; install: () => Promise<void> };
let pending: Pending | null = null;

export type CheckResult = { state: 'upToDate' } | { state: 'ready'; version: string } | { state: 'failed'; reason: string };

/** How long GitHub has to answer a check, and an update to download: the updater's own timeouts. */
export const CHECK_TIMEOUT_MS = 30_000;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/**
 * A little past the updater's own timeout, a check gives up by itself: a request the updater never
 * ends (a stalled connection) would otherwise keep it going, and every later one waiting, until
 * the app quits.
 */
export const DEADLINE_GRACE_MS = 15_000;
export const CHECK_DEADLINE_MS = CHECK_TIMEOUT_MS + DEADLINE_GRACE_MS;
export const DOWNLOAD_DEADLINE_MS = DOWNLOAD_TIMEOUT_MS + DEADLINE_GRACE_MS;

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

class TookTooLong extends Error {}

/**
 * `work`, or TookTooLong once `ms` have passed without an answer. What the abandoned call answers
 * later goes to `late` and nowhere else.
 */
function within<T>(work: Promise<T>, ms: number, late: (v: T) => void = () => {}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let gaveUp = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { gaveUp = true; reject(new TookTooLong()); }, ms);
  });
  work.then(v => { if (gaveUp) late(v); }, () => { /* too late to matter */ });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** Lets go of an update a check found but won't offer (the plugin keeps it until closed). */
function letGo(update: Update | null) {
  try { void update?.close().catch(() => undefined); } catch { /* nothing to let go of */ }
}

/**
 * A check gives up on its own: GitHub has CHECK_DEADLINE_MS to answer, and an update it offers
 * DOWNLOAD_DEADLINE_MS to download. A check that gave up says it failed, and the abandoned call
 * changes nothing later: an update it then finds, or finishes downloading, isn't offered. That's
 * the safe side: About and the scheduler have been told this check failed, a newer one may be going
 * on by then, and the next check (an hour on, or About's button) finds the update again.
 */
async function runCheck(): Promise<CheckResult> {
  if (!isTauri()) {
    await new Promise(r => setTimeout(r, 1200));
    noteChecked();
    return { state: 'upToDate' };
  }
  let update: Update | null = null;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    update = await within(check({ timeout: CHECK_TIMEOUT_MS }), CHECK_DEADLINE_MS, letGo);
    noteChecked();
    if (!update) return { state: 'upToDate' };
    const found = update;
    await within(found.download(undefined, { timeout: DOWNLOAD_TIMEOUT_MS }), DOWNLOAD_DEADLINE_MS);   // signature is verified by the plugin
    pending = { version: found.version, install: () => found.install() };
    useSystem.getState().setUpdateReady(found.version);
    return { state: 'ready', version: found.version };
  } catch (e) {
    if (!(e instanceof TookTooLong)) return { state: 'failed', reason: "Couldn't reach GitHub to check for updates." + (e instanceof Error ? ` (${e.message})` : '') };
    letGo(update);
    return { state: 'failed', reason: update
      ? `Breakpatch ${update.version} took too long to download. Breakpatch tries again within the hour.`
      : "GitHub didn't answer in time. Breakpatch tries again within the hour." };
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

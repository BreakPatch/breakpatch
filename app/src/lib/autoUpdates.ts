// Automatic update checks (docs/manual.md "Updates"): one a little after the app opens, then one an
// hour while it's open. An update found downloads in the background and SystemBanners says it's
// ready, with Restart to update; nothing else shows, and a check that fails (offline, GitHub
// unreachable or rate-limited) is simply tried again an hour on.
//
// One scheduler for the window, started by the app shell (components/shell/AutoUpdates.tsx).
// Starting it again while it runs (React StrictMode's second mount, a hot reload) adds no timer;
// it stops when the last start is undone.
//
// It goes by the clock, not by counting timers: every tick (at most a minute apart) it asks
// whether an hour has passed since the last check started. Timers stand still while the Mac
// sleeps, so after a three-hour sleep the next tick finds one check due, not three.
//
// Not in a browser (the preview) or with the demo engine (`?demo`), nor for a copy its package
// manager updates (a Linux .deb: updates.ts updateSource). Not while one is going on
// (About's button included: that one counts as the hour's check), nor once an update is waiting
// for a restart. While the app is busy (holdUpdateChecks: recording, a run, setup's downloads) a
// check that falls due waits until it isn't, or for a later tick.
import { isTauri, wantsDemo } from '../platform';
import { useSystem } from '../state/system';
import { checkForUpdates, isCheckingForUpdates, knownUpdateSource, lastCheckStarted, updateSource } from './updates';

/** After the app opens: long enough for the engine to start first. */
export const FIRST_CHECK_MS = 10_000;
export const CHECK_EVERY_MS = 60 * 60_000;
/** The longest a tick waits, so a check comes soon after the Mac wakes. */
export const TICK_MS = 60_000;

let starts = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** When the scheduler first started in this window: the first check is FIRST_CHECK_MS after. */
let openedAt: number | null = null;
let holds = 0;

function dueAt(): number {
  const first = (openedAt ?? Date.now()) + FIRST_CHECK_MS;
  const last = lastCheckStarted();
  return last === null ? first : Math.max(first, last + CHECK_EVERY_MS);
}

function schedule() {
  if (timer) clearTimeout(timer);
  const left = dueAt() - Date.now();
  // Due already but held back (busy, a check going on, an update waiting): look again in a tick.
  timer = setTimeout(tick, left > 0 ? Math.min(left, TICK_MS) : TICK_MS);
}

function tick() {
  timer = null;
  checkIfDue();
  if (starts > 0) schedule();
}

function checkIfDue() {
  if (starts === 0 || holds > 0 || Date.now() < dueAt()) return;
  if (knownUpdateSource() === 'package') return;   // a .deb: its package manager updates it
  if (useSystem.getState().updateReady || isCheckingForUpdates()) return;
  void checkForUpdates();               // a failure shows nothing: the next one is an hour on
}

/** Whether this window checks by itself: the app, with its own engine. */
export function autoUpdatesApply(): boolean { return isTauri() && !wantsDemo(); }

/** Starts the scheduler (once, however often it's called). Returns the call that undoes this start. */
export function startAutoUpdates(): () => void {
  if (!autoUpdatesApply()) return () => {};
  starts++;
  if (starts === 1) { openedAt ??= Date.now(); void updateSource(); schedule(); }
  let undone = false;
  return () => {
    if (undone) return;
    undone = true;
    starts = Math.max(0, starts - 1);   // never below 0, even after a hot reload reset it
    if (starts === 0 && timer) { clearTimeout(timer); timer = null; }
  };
}

/**
 * Keeps automatic checks back while the app is busy (recording, a run, setup's downloads). Returns
 * the release; once nothing holds them, a check that fell due meanwhile starts at once.
 */
export function holdUpdateChecks(): () => void {
  holds++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds = Math.max(0, holds - 1);
    // A moment later: a hold released and taken again at once (a screen's effect re-running,
    // StrictMode's second mount) doesn't start a check in between.
    if (holds === 0) queueMicrotask(checkIfDue);
  };
}

/** For tests only. */
export function resetAutoUpdatesForTests(): void {
  if (timer) clearTimeout(timer);
  timer = null; starts = 0; openedAt = null; holds = 0;
}

// A hot reload replaces this module: the old one's timer goes with it.
if (import.meta.hot) import.meta.hot.dispose(() => resetAutoUpdatesForTests());

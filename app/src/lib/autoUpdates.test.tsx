// Automatic update checks (lib/autoUpdates.ts, components/shell/AutoUpdates.tsx), with fake timers
// and the Tauri updater mocked.
import { StrictMode } from 'react';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock('@tauri-apps/plugin-updater', () => ({ check: updater.check }));

import { CHECK_EVERY_MS, FIRST_CHECK_MS, TICK_MS, holdUpdateChecks, resetAutoUpdatesForTests, startAutoUpdates } from './autoUpdates';
import { checkForUpdates, lastChecked, resetUpdatesForTests } from './updates';
import { AutoUpdates } from '../components/shell/AutoUpdates';
import { useSystem } from '../state/system';

const MIN = 60_000;
const START = new Date('2026-10-12T09:00:00Z').getTime();
const win = window as unknown as Record<string, unknown>;
const realTimeout = globalThis.setTimeout;                         // taken before the clock is faked

/** An update the updater offers: download and install do nothing. */
function anUpdate(version = '0.2.0') {
  return { version, download: vi.fn(async () => {}), install: vi.fn(async () => {}) };
}
/** A check that answers only when told to. */
function heldCheck() {
  let answer!: (v: unknown) => void;
  updater.check.mockImplementationOnce(() => new Promise(r => { answer = r; }));
  return { answer: (v: unknown) => answer(v) };
}

/** Lets promises (the updater's dynamic import, its answer) settle; timers stay put. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise(r => realTimeout(r, 0));
}
/** Moves the clock on, firing the timers on the way, and lets what they started settle. */
async function wait(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); await settle(); });
}

beforeEach(async () => {
  vi.useFakeTimers({ now: START, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });   // not queueMicrotask
  win.__TAURI_INTERNALS__ = {};
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  updater.check.mockReset();
  updater.check.mockResolvedValue(null);
  resetUpdatesForTests();
  resetAutoUpdatesForTests();
  useSystem.setState({ updateReady: null, updateDismissed: false, error: null });
  await import('@tauri-apps/plugin-updater');      // loaded once, as in the app after the first check
});
afterEach(() => {
  resetAutoUpdatesForTests();
  delete win.__TAURI_INTERNALS__;
  vi.useRealTimers();
});

describe('automatic update checks', () => {
  it('checks once, FIRST_CHECK_MS after the app opens', async () => {
    startAutoUpdates();
    await wait(FIRST_CHECK_MS - 1);
    expect(updater.check).not.toHaveBeenCalled();
    await wait(1);
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(lastChecked()).toBe(START + FIRST_CHECK_MS);           // About's "Last checked"
    await wait(10 * MIN);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  it('checks again every hour while the app is open', async () => {
    startAutoUpdates();
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    await wait(CHECK_EVERY_MS - MIN);
    expect(updater.check).toHaveBeenCalledTimes(1);
    await wait(MIN);
    expect(updater.check).toHaveBeenCalledTimes(2);
    await wait(CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(3);
  });

  it('downloads an update it finds and says it is ready, then checks no more', async () => {
    const update = anUpdate('0.2.0');
    updater.check.mockResolvedValueOnce(update);
    startAutoUpdates();
    await wait(FIRST_CHECK_MS);
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(update.install).not.toHaveBeenCalled();
    expect(useSystem.getState().updateReady).toBe('0.2.0');
    await wait(5 * CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  it("doesn't check while an update is already waiting for a restart", async () => {
    useSystem.getState().setUpdateReady('0.2.0');
    startAutoUpdates();
    await wait(3 * CHECK_EVERY_MS);
    expect(updater.check).not.toHaveBeenCalled();
  });

  it('About joins an automatic check going on instead of starting another', async () => {
    const held = heldCheck();
    startAutoUpdates();
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    const byHand = checkForUpdates();                              // About's button, meanwhile
    await settle();
    expect(updater.check).toHaveBeenCalledTimes(1);
    held.answer(null);
    await expect(byHand).resolves.toEqual({ state: 'upToDate' });
  });

  it('skips its check while one started from About is going on, and counts that one as the hour\'s', async () => {
    startAutoUpdates();
    await wait(FIRST_CHECK_MS - 2_000);
    const held = heldCheck();
    const byHand = checkForUpdates();                              // 2 s before the first automatic one
    await settle();
    expect(updater.check).toHaveBeenCalledTimes(1);
    await wait(5 * MIN);                                           // still going on: nothing more
    expect(updater.check).toHaveBeenCalledTimes(1);
    held.answer(null);
    await expect(byHand).resolves.toEqual({ state: 'upToDate' });
    await wait(CHECK_EVERY_MS - 5 * MIN - MIN);                    // an hour after About's started, less a minute
    expect(updater.check).toHaveBeenCalledTimes(1);
    await wait(MIN);
    expect(updater.check).toHaveBeenCalledTimes(2);
  });

  it('a check that fails shows nothing and is tried again an hour later', async () => {
    updater.check.mockRejectedValueOnce(new Error('error sending request: offline'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    startAutoUpdates();
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(useSystem.getState().error).toBeNull();
    expect(useSystem.getState().updateReady).toBeNull();
    expect(lastChecked()).toBeNull();                              // GitHub never answered
    await wait(30 * MIN);
    expect(updater.check).toHaveBeenCalledTimes(1);                // no quick retries
    const update = anUpdate('0.2.0');
    updater.check.mockResolvedValueOnce(update);
    await wait(30 * MIN);
    expect(updater.check).toHaveBeenCalledTimes(2);
    expect(useSystem.getState().updateReady).toBe('0.2.0');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it('after a long sleep, the next tick checks once, not once per hour missed', async () => {
    startAutoUpdates();
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    await wait(20 * MIN);
    // The Mac sleeps three hours: the clock moves on, timers stand still.
    vi.setSystemTime(Date.now() + 3 * CHECK_EVERY_MS);
    await wait(TICK_MS);
    expect(updater.check).toHaveBeenCalledTimes(2);
    await wait(10 * TICK_MS);
    expect(updater.check).toHaveBeenCalledTimes(2);
    await wait(CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(3);
  });

  it('waits while the app is busy, then checks once it isn\'t', async () => {
    startAutoUpdates();
    const release = holdUpdateChecks();
    await wait(FIRST_CHECK_MS + 2 * CHECK_EVERY_MS);
    expect(updater.check).not.toHaveBeenCalled();
    release();
    await wait(0);
    expect(updater.check).toHaveBeenCalledTimes(1);                // one, for all the time held
    release();                                                     // twice is harmless
    await wait(CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(2);
  });

  it('a hold released and taken again at once starts no check in between', async () => {
    startAutoUpdates();
    let release = holdUpdateChecks();
    await wait(FIRST_CHECK_MS);
    release(); release = holdUpdateChecks();                       // an effect re-running
    await wait(0);
    expect(updater.check).not.toHaveBeenCalled();
    release();
    await wait(0);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });

  it("doesn't run in a browser (the preview) or with the demo engine", async () => {
    delete win.__TAURI_INTERNALS__;
    startAutoUpdates();
    expect(vi.getTimerCount()).toBe(0);
    win.__TAURI_INTERNALS__ = {};
    window.history.replaceState(null, '', '/?demo');
    startAutoUpdates();
    expect(vi.getTimerCount()).toBe(0);
    await wait(2 * CHECK_EVERY_MS);
    expect(updater.check).not.toHaveBeenCalled();
  });

  it('starting twice adds no timer, and it stops once both are undone', async () => {
    const stopA = startAutoUpdates(), stopB = startAutoUpdates();
    expect(vi.getTimerCount()).toBe(1);
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    stopA(); stopA();
    expect(vi.getTimerCount()).toBe(1);
    stopB();
    expect(vi.getTimerCount()).toBe(0);
    await wait(3 * CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });
});

describe('AutoUpdates in the app shell', () => {
  const shell = () => <StrictMode><AutoUpdates /></StrictMode>;

  it("StrictMode's double mount leaves one timer and one check", async () => {
    render(shell());
    expect(vi.getTimerCount()).toBe(1);
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await wait(CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(2);
  });

  it('a second mount (a hot reload) adds no timer either', async () => {
    const first = render(shell());
    const second = render(shell());
    expect(vi.getTimerCount()).toBe(1);
    first.unmount();
    expect(vi.getTimerCount()).toBe(1);
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    second.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('unmounting stops the checks', async () => {
    const { unmount } = render(shell());
    await wait(FIRST_CHECK_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await wait(3 * CHECK_EVERY_MS);
    expect(updater.check).toHaveBeenCalledTimes(1);
  });
});

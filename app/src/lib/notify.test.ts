import { afterEach, describe, expect, it, vi } from 'vitest';
import { notificationFor, notifyFinished, oneLine, takePendingReport } from './notify';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const failedTest = { kind: 'test' as const, name: 'Test2', result: 'fail' as const, failedAt: { number: 9, label: 'Click Close button' }, path: '/apps/a/runs/r1' };
const passedTest = { kind: 'test' as const, name: 'Test2', result: 'pass' as const, path: '/apps/a/runs/r2' };
const suite = (failed: number) => ({ kind: 'suite' as const, name: 'Smoke', tests: 12, failed, durationMs: 4 * 60_000, path: '/suites/s' });

describe('run notifications', () => {
  it('says only failures by default, and nothing while the window has the focus', () => {
    expect(oneLine(notificationFor(failedTest, {}, false)!)).toBe('Test2 failed at step 9, Click Close button');
    expect(notificationFor(passedTest, {}, false)).toBeNull();
    expect(notificationFor(failedTest, {}, true)).toBeNull();
    expect(notificationFor(failedTest, { notifyFailures: false }, false)).toBeNull();
  });
  it('says every finished run when that is on', () => {
    expect(notificationFor(passedTest, { notifyAll: true }, false)?.title).toBe('Test2 passed');
    expect(notificationFor(suite(0), { notifyAll: true }, false)?.title).toBe('Smoke suite passed: 12 tests in 4 min');
    expect(notificationFor(suite(0), {}, false)).toBeNull();
  });
  it('words a suite that failed', () => {
    expect(notificationFor(suite(3), {}, false)?.title).toBe('Smoke suite: 3 of 12 failed');
    expect(notificationFor(suite(3), {}, false)?.path).toBe('/suites/s');
  });
  it('asks macOS once, shows it, and opens the report when the app comes forward', async () => {
    vi.stubGlobal('__TAURI_INTERNALS__', {});
    const calls: [string, unknown][] = [];
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (cmd: string, args: unknown) => {
      calls.push([cmd, args]);
      return cmd.endsWith('is_permission_granted') ? false : cmd.endsWith('request_permission') ? 'granted' : null;
    }) }));
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    expect(await notifyFinished(failedTest, {}, false)).toBe(true);
    expect(calls.map(c => c[0])).toEqual(['plugin:notification|is_permission_granted', 'plugin:notification|request_permission', 'plugin:notification|notify']);
    expect(calls[2][1]).toEqual({ options: { title: 'Test2 failed', body: 'At step 9, Click Close button' } });
    expect(takePendingReport()).toBe('/apps/a/runs/r1');
    expect(takePendingReport()).toBeNull();
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });
});

// Shared rules every backend follows: what Test details change, and where a version starts.
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanDetails, detailsDiff, startUrlOf } from './backend';
import { DemoBackend } from './demo/demoBackend';
import { useSession } from '../state/session';
import { getEngine, type EngineEvents } from '../engine';
import { prepareTest, useTestRun } from '../screens/run/useTestRun';

afterEach(() => { vi.restoreAllMocks(); });

const VP = { width: 1440, height: 900, dpr: 1 as const };

describe('detailsDiff', () => {
  const t = { name: 'Log in', description: undefined, startUrl: 'https://app.example.com' };
  it('says what changes, with no description and an empty one the same', () => {
    expect(detailsDiff(t, cleanDetails({ name: ' Log in ', description: ' ', startUrl: 'https://app.example.com ' }))).toEqual({ name: false, description: false, moved: false, changed: false });
    expect(detailsDiff({ ...t, description: '' }, cleanDetails({ ...t, description: '' }))).toMatchObject({ changed: false });
    expect(detailsDiff(t, cleanDetails({ ...t, name: 'Sign in' }))).toEqual({ name: true, description: false, moved: false, changed: true });
    expect(detailsDiff(t, cleanDetails({ ...t, description: 'Signs in' }))).toMatchObject({ description: true, moved: false, changed: true });
    expect(detailsDiff(t, cleanDetails({ ...t, startUrl: 'https://app.example.com/login' }))).toMatchObject({ moved: true, changed: true });
  });
});

describe('where a version starts', () => {
  it('at its own start address, else the test\'s', () => {
    expect(startUrlOf({ startUrl: 'https://a.example.com' }, { startUrl: 'https://a.example.com/v2' })).toBe('https://a.example.com/v2');
    expect(startUrlOf({ startUrl: 'https://a.example.com' }, {})).toBe('https://a.example.com');
    expect(startUrlOf({ startUrl: 'https://a.example.com' }, null)).toBe('https://a.example.com');
  });

  it('a run on this Mac starts where the version it runs starts', async () => {
    const backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
    useSession.setState({ backend });
    const app = await backend.addApp({ name: 'Web', baseUrl: 'https://app.example.com', defaultViewport: VP });
    const created = await backend.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com', viewport: VP });
    const v = await backend.saveTest(app.id, created.id, [{ id: 's1', action: 'click', label: 'Click Log in', at: [10, 10] }]);
    const test = { ...created, currentVersion: v.number };
    // A version that starts somewhere else than the test says now (a pinned or released one).
    vi.spyOn(backend, 'version').mockResolvedValue({ ...v, startUrl: 'https://app.example.com/v1-start' });
    expect((await prepareTest(backend, test)).startUrl).toBe('https://app.example.com/v1-start');
    const engine = getEngine() as unknown as { emit<K extends keyof EngineEvents>(e: K, d: EngineEvents[K]): void };
    const startRun = vi.spyOn(getEngine(), 'startRun').mockImplementation(async r => {
      setTimeout(() => engine.emit('run.ended', { runId: r.runId, result: 'pass', durationMs: 1, steps: [{ stepId: 's1', result: 'passed' }] }), 0);
    });
    const { result } = renderHook(() => useTestRun());
    await act(async () => { await result.current.start(test, { notify: false }); });
    expect(startRun.mock.calls[0][0].startUrl).toBe('https://app.example.com/v1-start');
  });
});

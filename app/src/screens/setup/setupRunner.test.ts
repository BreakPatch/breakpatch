import { describe, expect, it, vi } from 'vitest';
import { EngineError, MODELS, type Engine, type EngineEvents, type SystemInfo } from '../../engine/engine';
import { SetupRunner } from './setupRunner';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}

function fakeEngine(info: Partial<SystemInfo> = {}) {
  const handlers: ((d: EngineEvents['setup.progress']) => void)[] = [];
  const calls = { browser: [] as Deferred<{ version: string }>[], model: [] as Deferred<{ path: string; sizeBytes: number }>[], modelArgs: [] as string[][] };
  const engine = {
    on: (_: string, cb: (d: EngineEvents['setup.progress']) => void) => { handlers.push(cb); return () => {}; },
    systemInfo: vi.fn(async (): Promise<SystemInfo> => ({
      memoryGb: 16, chip: 'M2', os: 'macOS', engineVersion: '0', edition: 'community', browser: { installed: false }, model: { installed: false }, ...info,
    })),
    installBrowser: vi.fn(() => { const d = deferred<{ version: string }>(); calls.browser.push(d); return d.promise; }),
    downloadModel: vi.fn((repo: string, rev: string) => { const d = deferred<{ path: string; sizeBytes: number }>(); calls.model.push(d); calls.modelArgs.push([repo, rev]); return d.promise; }),
    pauseSetup: vi.fn(async () => {}),
  } as unknown as Engine;
  const emit = (d: EngineEvents['setup.progress']) => handlers.forEach(h => h(d));
  return { engine, calls, emit };
}
const tick = () => new Promise(r => setTimeout(r, 0));
const states = (r: SetupRunner) => [r.state.rows.browser.state, r.state.rows.mac.state, r.state.rows.model.state];

describe('SetupRunner', () => {
  it('runs browser, then the Mac check, then the standard model even on a 36 GB Mac', async () => {
    const { engine, calls, emit } = fakeEngine({ memoryGb: 36 });
    const r = new SetupRunner(engine, 0);
    r.start(); await tick();
    expect(states(r)).toEqual(['busy', 'waiting', 'waiting']);
    emit({ task: 'browser', state: 'busy', doneBytes: 50, totalBytes: 100 });
    expect(r.state.rows.browser.doneBytes).toBe(50);
    calls.browser[0].resolve({ version: 'Chromium' }); await tick(); await tick();
    expect(r.state.model).toBe(MODELS.standard);
    expect(calls.modelArgs[0]).toEqual([MODELS.standard.repo, MODELS.standard.revision]);
    expect(states(r)).toEqual(['done', 'done', 'busy']);
    calls.model[0].resolve({ path: '/m', sizeBytes: 5.2e9 }); await tick();
    expect(r.done).toBe(true);
    expect(r.state.modelBytes).toBe(5.2e9);
  });

  it('skips what is already installed', async () => {
    const { engine } = fakeEngine({ browser: { installed: true }, model: { installed: true, repo: MODELS.standard.repo, sizeBytes: 3.1e9 } });
    const r = new SetupRunner(engine, 0);
    r.start(); await tick(); await tick(); await tick();
    expect(r.done).toBe(true);
    expect(engine.installBrowser).not.toHaveBeenCalled();
    expect(engine.downloadModel).not.toHaveBeenCalled();
  });

  it('keeps the larger model when someone already chose it', async () => {
    const { engine } = fakeEngine({ memoryGb: 32, browser: { installed: true }, model: { installed: true, repo: MODELS.larger.repo } });
    const r = new SetupRunner(engine, 0);
    r.start(); await tick(); await tick(); await tick();
    expect(r.done).toBe(true);
    expect(r.state.model).toBe(MODELS.larger);
    expect(engine.downloadModel).not.toHaveBeenCalled();
  });

  it('never picks the larger model on its own', async () => {
    const { engine } = fakeEngine({ memoryGb: 64, browser: { installed: true } });
    const r = new SetupRunner(engine, 0);
    r.start(); await tick(); await tick(); await tick();
    expect(engine.downloadModel).toHaveBeenCalledWith(MODELS.standard.repo, MODELS.standard.revision);
  });

  it('pauses and resumes by calling the start method again', async () => {
    const { engine, calls, emit } = fakeEngine({ browser: { installed: true } });
    const r = new SetupRunner(engine, 0);
    r.start(); await tick(); await tick(); await tick();
    emit({ task: 'model', state: 'busy', doneBytes: 1.3e9, totalBytes: 3.1e9 });
    await r.pause();
    expect(engine.pauseSetup).toHaveBeenCalledWith('model');
    expect(r.state.rows.model).toMatchObject({ state: 'paused', reason: 'Lost connection to the internet.', doneBytes: 1.3e9 });
    // The old call failing after the pause doesn't turn it into a failure.
    calls.model[0].reject(new EngineError('paused', 'Paused')); await tick();
    expect(r.state.rows.model.state).toBe('paused');
    r.start(); await tick();
    expect(engine.downloadModel).toHaveBeenCalledTimes(2);
    expect(r.state.rows.model).toMatchObject({ state: 'busy', doneBytes: 1.3e9 });
    calls.model[1].resolve({ path: '/m', sizeBytes: 3.1e9 }); await tick();
    expect(r.done).toBe(true);
  });

  it('shows a paused event from the engine with its reason', async () => {
    const { engine, emit } = fakeEngine({ browser: { installed: true } });
    const r = new SetupRunner(engine, 0);
    r.start(); await tick(); await tick(); await tick();
    emit({ task: 'model', state: 'paused', doneBytes: 2e9, message: 'The Mac went to sleep.' });
    expect(r.state.rows.model).toMatchObject({ state: 'paused', reason: 'The Mac went to sleep.' });
  });

  it('fails with a plain reason, keeps later tasks waiting, and retries', async () => {
    const { engine, calls } = fakeEngine();
    const r = new SetupRunner(engine, 0);
    r.start(); await tick();
    calls.browser[0].reject(new EngineError('disk_full', "There isn't enough free space on this Mac.", 'ENOSPC')); await tick();
    expect(states(r)).toEqual(['failed', 'waiting', 'waiting']);
    expect(r.state.rows.browser).toMatchObject({ reason: "There isn't enough free space on this Mac.", details: 'Code: disk_full\nENOSPC' });
    r.retry(); await tick();
    expect(states(r)).toEqual(['busy', 'waiting', 'waiting']);
    expect(r.state.rows.browser.reason).toBeUndefined();
    expect(engine.systemInfo).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoBackend } from './demo/demoBackend';
import { countUsage, runSourceOf } from './countUsage';
import { initFolder } from './local/folder';
import { LocalBackend } from './local/localBackend';
import { MemoryStorage } from './local/storage';
import type { Person, Run } from './types';

const ROOT = '/Users/ana/web-app/tests';
const ana: Person = { uid: 'local', name: 'Ana Ruiz', email: '' };
const VP = { width: 1440, height: 900, dpr: 1 as const };
const opened: LocalBackend[] = [];
afterEach(() => { opened.splice(0).forEach(b => b.close()); vi.restoreAllMocks(); });

async function folder() {
  const st = new MemoryStorage();
  await st.mkdir(ROOT);
  await initFolder(st, ROOT);
  const b = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false });
  opened.push(b);
  return b;
}
const recorder = () => ({ testCreated: vi.fn(), run: vi.fn() });
const runOf = (appId: string, testId: string, over: Partial<Run> = {}): Omit<Run, 'id'> => ({
  appId, testId, testName: 'Log in', testVersion: 1, startedBy: ana, machine: 'Mac', source: 'desktop',
  startedAt: Date.now(), durationMs: 1200, result: 'pass', healedCount: 0, steps: [], ...over,
});

describe('usage counts where tests and runs are saved', () => {
  it('counts a new test, a copy and each run with where it came from and its result, and nothing else', async () => {
    const rec = recorder();
    const b = countUsage(await folder(), rec);
    const app = await b.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
    const t = await b.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com/login', viewport: VP });
    await b.saveTest(app.id, t.id, [{ id: 's1', action: 'navigate', label: 'Go', url: 'https://app.example.com' }]);
    await b.duplicateTest(app.id, t.id);
    expect(rec.testCreated).toHaveBeenCalledTimes(2);
    expect(rec.testCreated.mock.calls.every(c => c.length === 0)).toBe(true);   // no names, no addresses

    await b.addRun(runOf(app.id, t.id));
    await b.addRun(runOf(app.id, t.id, { result: 'fail' }));
    expect(rec.run.mock.calls).toEqual([['manual', 'pass'], ['manual', 'fail']]);
  });

  it('counts nothing when the save fails', async () => {
    const rec = recorder();
    const b = countUsage(await folder(), rec);
    await expect(b.createTest({ appId: 'no-such-app', name: 'x', startUrl: 'https://x', viewport: VP })).rejects.toThrow();
    expect(rec.testCreated).not.toHaveBeenCalled();
  });

  it('is the same backend otherwise: its fields, other methods, instanceof and live reads', async () => {
    const inner = await folder();
    const b = countUsage(inner, recorder());
    expect(b).toBeInstanceOf(LocalBackend);
    expect(b.kind).toBe('local');
    expect(b.local.path).toBe(ROOT);
    expect(b.currentUser()).toEqual(ana);
    expect(b.apps).toBe(b.apps);
    const apps = await new Promise(res => { const off = b.apps(v => { queueMicrotask(() => off()); res(v); }); });
    expect(apps).toEqual([]);
  });

  it('leaves the demo’s sample data out', () => {
    const demo = new DemoBackend({ empty: true, signedIn: true });
    expect(countUsage(demo, recorder())).toBe(demo);
  });

  it('tells runs by hand, on the runner, for a schedule and in CI apart', () => {
    expect(runSourceOf({ source: 'desktop' })).toBe('manual');
    expect(runSourceOf({ source: 'runner' })).toBe('runner');
    expect(runSourceOf({ source: 'runner' }, 'schedule')).toBe('schedule');
    expect(runSourceOf({ source: 'ci' })).toBe('ci');
  });
});

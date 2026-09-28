import { describe, expect, it } from 'vitest';
import type { Person, Run, Test } from '../../data/types';
import { distinct, filterRuns, filterTests } from './filters';
import { callProblem, cleanCall, describeReply, isHttpAddress, tryCall } from './tryCall';
import type { CallReply, Engine } from '../../engine/engine';

const p = (uid: string): Person => ({ uid, name: uid.toUpperCase(), email: uid + '@x.com' });
const test = (id: string, over: Partial<Test> = {}): Test => ({
  id, appId: 'a', name: id, startUrl: 'https://x', status: 'draft', viewport: { width: 1440, height: 900, dpr: 1 }, currentVersion: 1, stepCount: 3,
  createdBy: p('maria'), createdAt: 0, updatedBy: p('maria'), updatedAt: 0, ...over,
});

describe('filterTests', () => {
  const tests = [
    test('Create a project', { status: 'published', lastRun: { result: 'healed', at: 1, by: 'x' } }),
    test('Log in and out', { status: 'published', createdBy: p('tom'), lastRun: { result: 'pass', at: 1, by: 'x' } }),
    test('Archive a project', { createdBy: p('tom') }),
  ];
  const all = { q: '', shared: 'all', lastRun: 'all', createdBy: 'all' } as const;
  it('searches by name, case-insensitive', () => expect(filterTests(tests, { ...all, q: 'PROJECT' }).map(t => t.id)).toEqual(['Create a project', 'Archive a project']));
  it('filters shared', () => expect(filterTests(tests, { ...all, shared: 'draft' }).map(t => t.id)).toEqual(['Archive a project']));
  it('filters last run incl. never', () => {
    expect(filterTests(tests, { ...all, lastRun: 'fixed' }).map(t => t.id)).toEqual(['Create a project']);
    expect(filterTests(tests, { ...all, lastRun: 'never' }).map(t => t.id)).toEqual(['Archive a project']);
  });
  it('filters created by', () => expect(filterTests(tests, { ...all, createdBy: 'tom' })).toHaveLength(2));
});

describe('filterRuns', () => {
  const run = (id: string, over: Partial<Run>): Run => ({ id, appId: 'a', testId: 't1', testName: 'T', testVersion: 1, startedBy: p('maria'), machine: 'm', source: 'desktop', startedAt: 0, durationMs: 1, result: 'pass', healedCount: 0, steps: [], ...over });
  const runs = [run('1', {}), run('2', { result: 'fail', source: 'ci', startedBy: { serviceAccount: 'Nightly suite' } }), run('3', { healedCount: 1, testId: 't2' })];
  const all = { testId: 'all', result: 'all', where: 'all', who: 'all' } as const;
  it('by result', () => {
    expect(filterRuns(runs, { ...all, result: 'passedWithFixes' }).map(r => r.id)).toEqual(['3']);
    expect(filterRuns(runs, { ...all, result: 'passed' }).map(r => r.id)).toEqual(['1']);
  });
  it('by where, who, test', () => {
    expect(filterRuns(runs, { ...all, where: 'ci' }).map(r => r.id)).toEqual(['2']);
    expect(filterRuns(runs, { ...all, who: 'Nightly suite' }).map(r => r.id)).toEqual(['2']);
    expect(filterRuns(runs, { ...all, testId: 't2' }).map(r => r.id)).toEqual(['3']);
  });
  it('distinct keeps first-seen order', () => expect(distinct([3, 1, 3, 2, 1], x => x)).toEqual([3, 1, 2]));
});

describe('tryCall', () => {
  const engine = (answer: CallReply | Error, seen: unknown[] = []) => ({
    tryCall: async (...args: unknown[]) => { seen.push(args); if (answer instanceof Error) throw answer; return answer; },
  }) as unknown as Engine;
  const appUrl = 'https://app.example.com';

  it('rejects addresses that are not http(s) without asking the engine', async () => {
    const seen: unknown[] = [];
    expect(isHttpAddress('ftp://x')).toBe(false);
    expect(await tryCall({ method: 'GET', url: 'nope' }, { engine: engine({ ok: true }, seen), appUrl })).toEqual({ ok: false, error: 'invalid' });
    expect(seen).toEqual([]);
  });
  it('goes through the engine (not the webview fetch) with the app address and secrets', async () => {
    const seen: unknown[] = [];
    const r = await tryCall({ method: 'POST', url: ' https://api.example.com/seed ', headers: [{ name: 'Authorization', secretRef: 'TOKEN' }] },
      { engine: engine({ ok: true, status: 200, ms: 800 }, seen), appUrl, secrets: { TOKEN: 't' } });
    expect(r).toEqual({ ok: true, status: 200, ms: 800 });
    expect(describeReply(r)).toBe('Replied 200 in 0.8 s');
    expect(seen).toEqual([[{ method: 'POST', url: 'https://api.example.com/seed', headers: [{ name: 'Authorization', secretRef: 'TOKEN' }] }, appUrl, { TOKEN: 't' }]]);
  });
  it('reports an error status, a refusal and a network failure', async () => {
    expect(describeReply(await tryCall({ method: 'GET', url: 'https://x.dev' }, { engine: engine({ ok: false, status: 500, ms: 300, error: 'status', message: 'It replied 500.' }), appUrl }))).toBe('Replied 500 in 0.3 s');
    const refused = await tryCall({ method: 'GET', url: 'https://evil.example' }, { engine: engine({ ok: false, error: 'refused', message: "This call goes to evil.example, which isn't part of app.example.com. Turn on Allow other hosts for this test to call it." }), appUrl });
    expect(describeReply(refused)).toContain('Allow other hosts');
    expect(describeReply(await tryCall({ method: 'GET', url: 'https://x.dev' }, { engine: engine(new Error('engine gone')), appUrl }))).toBe("Couldn't reach this address");
    expect(describeReply({ ok: false, error: 'timeout' })).toBe('No reply after 15 s');
  });
});

describe('callProblem', () => {
  const app = 'https://app.acme.com/login';
  it('accepts the app and its sibling hosts over https', () => {
    expect(callProblem({ method: 'POST', url: 'https://api.acme.com/seed?x=1' }, app)).toBeUndefined();
    expect(callProblem({ method: 'POST', url: 'https://acme.com/seed' }, app)).toBeUndefined();
    expect(callProblem({ method: 'POST', url: '' }, app)).toBeUndefined();
  });
  it('asks for https, except on a local app', () => {
    expect(callProblem({ method: 'GET', url: 'http://api.acme.com/' }, app)).toContain('https://');
    expect(callProblem({ method: 'GET', url: 'http://localhost:3000/seed' }, 'http://localhost:3000')).toBeUndefined();
    expect(callProblem({ method: 'GET', url: 'http://localhost:3000/seed' }, app)).toContain('https://');
    expect(callProblem({ method: 'GET', url: 'file:///etc/passwd' }, app)).toBe('Enter a full address, starting with https://');
  });
  it('needs Allow other hosts for anything else', () => {
    expect(callProblem({ method: 'GET', url: 'https://evil.example/x' }, app)).toBe("This goes to evil.example, which isn't part of app.acme.com. Turn on Allow other hosts to call it.");
    expect(callProblem({ method: 'GET', url: 'https://evil.example/x', allowOtherHosts: true }, app)).toBeUndefined();
    expect(callProblem({ method: 'GET', url: 'https://b.github.io/' }, 'https://a.github.io/')).toContain('Allow other hosts');
  });
});

describe('cleanCall', () => {
  it('keeps named headers, a secret by name only, and the opt-in', () => {
    expect(cleanCall({ method: 'POST', url: ' https://api.acme.com/x ', headers: [{ name: ' X-Env ', value: 'test' }, { name: '', value: 'dropped' }, { name: 'Authorization', secretRef: 'TOKEN', value: 'ignored' }] }, true))
      .toEqual({ method: 'POST', url: 'https://api.acme.com/x', headers: [{ name: 'X-Env', value: 'test' }, { name: 'Authorization', secretRef: 'TOKEN' }], allowOtherHosts: true });
    expect(cleanCall({ method: 'GET', url: 'https://a.dev' }, false)).toEqual({ method: 'GET', url: 'https://a.dev' });
  });
});

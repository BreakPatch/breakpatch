import { afterEach, describe, expect, it, vi } from 'vitest';
import { KEEP_DELETED_MS, type Backend, type DeletedItem } from '../backend';
import type { Person, Run, Step, Test } from '../types';
import { NEWEST_READ_SCHEMA_VERSION, fromFileText, slugify, toFileText, uniqueSlug } from './format';
import { checkWritable, firstNameOf, initFolder, inspectFolder } from './folder';
import { FolderError, LocalBackend, NEWER_MESSAGE } from './localBackend';
import { baseName, isTempName, MemoryStorage } from './storage';

const ROOT = '/Users/ana/web-app/tests';
const ana: Person = { uid: 'local', name: 'Ana Ruiz', email: '' };
const VP = { width: 1440, height: 900, dpr: 1 as const };

async function setup(files: Record<string, string> = {}) {
  const st = new MemoryStorage();
  await st.mkdir(ROOT);
  await initFolder(st, ROOT);
  for (const [rel, text] of Object.entries(files)) st.poke(`${ROOT}/${rel}`, text);
  const b = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false });
  opened.push(b);
  return { st, b };
}
const opened: LocalBackend[] = [];
afterEach(() => { opened.splice(0).forEach(b => b.close()); vi.restoreAllMocks(); });

/** The next value a subscription gives. */
function first<T>(sub: (l: (v: T) => void) => () => void): Promise<T> {
  return new Promise(res => { const off = sub(v => { queueMicrotask(() => off()); res(v); }); });
}
const read = async (st: MemoryStorage, rel: string) => st.read(`${ROOT}/${rel}`);
const steps: Step[] = [
  { id: 's1', action: 'navigate', label: 'Go to the login page', url: 'https://app.example.com/login' },
  { id: 's2', action: 'click', label: 'Click Log in', target: 'Log in button', at: [640, 380], rerecorded: true },
];

async function appWithTest(b: LocalBackend) {
  const app = await b.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
  const test = await b.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com/login', viewport: VP });
  return { app, test };
}

describe('file format', () => {
  it('writes the same bytes whatever order the object was built in', () => {
    const a = toFileText({ updatedAt: 0, name: 'X', steps: [], zeta: 1, alpha: true, id: 'x' });
    const b = toFileText({ id: 'x', alpha: true, steps: [], name: 'X', zeta: 1, updatedAt: 0 });
    expect(a).toBe(b);
    expect(a.split('\n').map(l => l.trim().split(':')[0])).toEqual(['{', '"id"', '"name"', '"alpha"', '"zeta"', '"updatedAt"', '"steps"', '}', '']);
  });
  it('is 2-space JSON with a newline at the end, number pairs on one line and ISO times', () => {
    const t = toFileText({ name: 'Log in', at: [640, 380], createdAt: Date.UTC(2026, 8, 25, 14, 32, 5), nested: { x: 1 }, gone: undefined });
    expect(t).toBe('{\n  "name": "Log in",\n  "at": [640, 380],\n  "nested": {\n    "x": 1\n  },\n  "createdAt": "2026-09-25T14:32:05.000Z"\n}\n');
    expect(fromFileText<{ createdAt: number; at: number[] }>(t)).toEqual({ name: 'Log in', at: [640, 380], nested: { x: 1 }, createdAt: Date.UTC(2026, 8, 25, 14, 32, 5) });
  });
  it('makes readable, unique slugs', () => {
    expect(slugify('Log in & out — Café')).toBe('log-in-out-cafe');
    expect(slugify('!!!')).toBe('untitled');
    expect(uniqueSlug('Log in', id => ['log-in', 'log-in-2'].includes(id))).toBe('log-in-3');
  });
});

describe('choosing a folder', () => {
  it('tells empty, other and Breakpatch folders apart', async () => {
    const st = new MemoryStorage();
    await st.mkdir('/a'); st.poke('/a/.DS_Store', '');
    expect(await inspectFolder(st, '/a')).toBe('empty');
    st.poke('/a/README.md', '# hi');
    expect(await inspectFolder(st, '/a')).toBe('other');
    await initFolder(st, '/a');
    expect(await inspectFolder(st, '/a')).toBe('breakpatch');
    expect(await st.read('/a/breakpatch.json')).toBe('{\n  "format": "breakpatch",\n  "schemaVersion": 1,\n  "name": "a"\n}\n');
    expect(await st.exists('/a/apps')).toBe(true);
  });
  it('refuses a newer format, a broken breakpatch.json and a missing folder', async () => {
    const st = new MemoryStorage();
    st.poke('/new/breakpatch.json', `{"format":"breakpatch","schemaVersion":${NEWEST_READ_SCHEMA_VERSION + 1},"name":"x"}`);
    await expect(inspectFolder(st, '/new')).rejects.toThrow(NEWER_MESSAGE);
    await expect(LocalBackend.open({ storage: st, path: '/new', person: ana, live: false })).rejects.toMatchObject({ code: 'newer' });
    st.poke('/bad/breakpatch.json', '{ nope');
    await expect(inspectFolder(st, '/bad')).rejects.toMatchObject({ code: 'unreadable' });
    st.poke('/other/breakpatch.json', '{"format":"something"}');
    await expect(inspectFolder(st, '/other')).rejects.toMatchObject({ code: 'notBreakpatch' });
    await expect(inspectFolder(st, '/nowhere')).rejects.toBeInstanceOf(FolderError);
  });
  it('says so when the folder is not writable', async () => {
    const st = new MemoryStorage({ readOnly: ['/locked'] });
    st.poke('/locked/x.txt', 'x');
    await expect(checkWritable(st, '/locked')).rejects.toMatchObject({ code: 'notWritable' });
    await expect(initFolder(st, '/locked')).rejects.toMatchObject({ code: 'notWritable' });
    await st.mkdir('/fine');
    await expect(checkWritable(st, '/fine')).resolves.toBeUndefined();
    expect(await st.list('/fine')).toEqual([]);
  });
  it('never writes a name that starts with a dot', async () => {
    // Tauri's fs scope refuses dot files inside a picked folder on macOS (requireLiteralLeadingDot),
    // so a hidden temp file made "Couldn't open this folder" appear for every empty folder.
    const st = new MemoryStorage();
    const names: string[] = [];
    for (const m of ['write', 'rename', 'mkdir', 'remove'] as const) {
      const orig = st[m].bind(st) as (...a: string[]) => Promise<unknown>;
      vi.spyOn(st, m).mockImplementation(((...a: string[]) => { names.push(...a.map(baseName)); return orig(...a); }) as never);
    }
    await st.mkdir('/t'); names.length = 0;
    await checkWritable(st, '/t');
    await initFolder(st, '/t');
    const b = await LocalBackend.open({ storage: st, path: '/t', person: ana, live: false });
    await b.addApp({ name: 'Admin', baseUrl: 'https://admin.example.com', defaultViewport: VP });
    expect(names.length).toBeGreaterThan(4);
    expect(names.filter(n => n.startsWith('.'))).toEqual([]);
  });
  it('treats our leftover temp files as nothing', async () => {
    const st = new MemoryStorage();
    st.poke('/left/breakpatch.json.bp-abc123.tmp', 'half written');
    expect(isTempName('breakpatch.json.bp-abc123.tmp')).toBe(true);
    expect(isTempName('notes.tmp')).toBe(false);
    expect(await inspectFolder(st, '/left')).toBe('empty');
  });
});

describe('LocalBackend', () => {
  it('is one local person with no sign-in, members or runner', async () => {
    const { b } = await setup();
    expect(b.kind).toBe('local');
    expect(b.workspace).toBeNull();
    expect(b.local.path).toBe(ROOT);
    expect(b.currentUser()).toEqual(ana);
    expect(b.myRole()).toBe('admin');
    expect(await first(l => b.members(l))).toEqual([]);
    expect(await first(l => b.runner(l))).toBeNull();
    expect(await first(l => b.queue(l))).toEqual([]);
    expect(await first(l => b.suiteRuns(l))).toEqual([]);
    expect(await first(l => b.runRequests(l))).toEqual([]);
    const any: Backend = b;
    await expect(any.requestSuiteRun('x')).rejects.toThrow(/by hand on this Mac/);
    await expect(any.heartbeat({} as never)).rejects.toThrow();
    await expect(any.signIn('a@b.c', 'x')).rejects.toThrow(/no sign-in/);
    expect(firstNameOf(ana)).toBe('Ana');
    expect(firstNameOf({ uid: 'local', name: 'You', email: '' })).toBe('');
  });

  it('saves apps and tests as readable files named by slug', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    expect(app.id).toBe('web-app');
    expect(test.id).toBe('log-in');
    const appFile = await read(st, 'apps/web-app/app.json');
    expect(appFile).toMatch(/^{\n {2}"name": "Web app",\n {2}"baseUrl": "https:\/\/app.example.com",\n {2}"icon": "language",/);
    expect(appFile).not.toContain('"id"');
    const testFile = fromFileText<Record<string, unknown>>((await read(st, 'apps/web-app/tests/log-in.json'))!);
    expect(testFile).toMatchObject({ name: 'Log in', status: 'draft', version: 0, steps: [] });
    expect(testFile).not.toHaveProperty('id');
    expect(testFile).not.toHaveProperty('stepCount');
    // A second app or test with the same name gets its own slug.
    expect((await b.addApp({ name: 'Web app', baseUrl: 'x', defaultViewport: VP })).id).toBe('web-app-2');
    expect((await b.createTest({ appId: 'web-app', name: 'Log in', startUrl: 'x', viewport: VP })).id).toBe('log-in-2');
    const tests = await first<Test[]>(l => b.tests('web-app', l));
    expect(tests.map(t => t.id)).toEqual(['log-in', 'log-in-2']);
  });

  it('overwrites on save, counts versions in the file and keeps only the latest', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const v1 = await b.saveTest(app.id, test.id, steps);
    expect(v1).toMatchObject({ number: 1, savedBy: ana });
    expect(v1.steps[1]).not.toHaveProperty('rerecorded');
    const v2 = await b.saveTest(app.id, test.id, [...steps, { id: 's3', action: 'checkpoint', label: 'Check the dashboard' }]);
    expect(v2.number).toBe(2);
    const file = fromFileText<{ version: number; steps: Step[] }>((await read(st, 'apps/web-app/tests/log-in.json'))!);
    expect(file.version).toBe(2);
    expect(file.steps).toHaveLength(3);
    expect(await first(l => b.versions(app.id, test.id, l))).toEqual([expect.objectContaining({ number: 2 })]);
    expect((await b.version(app.id, test.id, 1))?.number).toBe(2);   // only the latest exists
    const t = await first<Test | null>(l => b.test(app.id, test.id, l));
    expect(t).toMatchObject({ currentVersion: 2, stepCount: 3 });
    expect(await st.list(`${ROOT}/apps/web-app/tests`)).toEqual([{ name: 'log-in.json', isDir: false }]);   // no temp files left
  });

  it('saves where the steps were recorded and keeps it through edits and renames', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const mac = { os: 'macOS', osVersion: '15.3', arch: 'arm64', chromium: '140.0.7339.16' };
    const v1 = await b.saveTest(app.id, test.id, steps, undefined, mac);
    expect(v1.recordedOn).toEqual(mac);
    const text = (await read(st, 'apps/web-app/tests/log-in.json'))!;
    expect(fromFileText<{ recordedOn: unknown }>(text).recordedOn).toEqual(mac);
    expect(text.indexOf('"recordedOn"')).toBeLessThan(text.indexOf('"steps"'));
    // An edit without recording keeps it; so does a rename. The test itself doesn't carry it.
    const v2 = await b.saveTest(app.id, test.id, [steps[0]]);
    expect(v2.recordedOn).toEqual(mac);
    await b.renameTest(app.id, test.id, 'Log in again');
    expect((await b.version(app.id, test.id, 2))?.recordedOn).toEqual(mac);
    expect(await first<Test | null>(l => b.test(app.id, test.id, l))).not.toHaveProperty('recordedOn');
    // Re-recorded on another system: a new version even with the same steps.
    const linux = { os: 'Linux', chromium: '140.0.7339.16' };
    expect((await b.saveTest(app.id, test.id, [steps[0]], undefined, linux)).number).toBe(3);
    expect((await b.snapshot()).apps[0].tests[0].recordedOn).toEqual(linux);
  });

  it('reads tests without recordedOn, and ignores one it cannot use', async () => {
    const { b } = await setup({
      'apps/web-app/app.json': toFileText({ name: 'Web app', baseUrl: 'https://app.example.com' }),
      'apps/web-app/tests/old.json': toFileText({ name: 'Old', version: 1, steps }),
      'apps/web-app/tests/odd.json': toFileText({ name: 'Odd', version: 1, recordedOn: { arch: 'arm64' }, steps }),
    });
    expect((await b.version('web-app', 'old', 1))?.recordedOn).toBeUndefined();
    expect((await b.version('web-app', 'odd', 1))?.recordedOn).toBeUndefined();
  });

  it('writes nothing when nothing changed', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.saveTest(app.id, test.id, steps);
    const before = await read(st, 'apps/web-app/tests/log-in.json');
    const write = vi.spyOn(st, 'write');
    const again = await b.saveTest(app.id, test.id, steps.map(s => ({ ...s })));
    await b.renameTest(app.id, test.id, 'Log in');
    await b.updateApp(app.id, { name: 'Web app' });
    expect(again.number).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect(await read(st, 'apps/web-app/tests/log-in.json')).toBe(before);
  });

  it('edits the test details: a new start address moves the version on, a name or description does not', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    // No steps yet: nothing to version.
    expect(await b.updateTestDetails(app.id, test.id, { name: 'Log in', startUrl: 'https://app.example.com/signin' })).toBeNull();
    await b.saveTest(app.id, test.id, steps);
    expect(await b.updateTestDetails(app.id, test.id, { name: '  Log in  ', description: '  Signs in  ', startUrl: 'https://app.example.com/signin' })).toBeNull();
    let t = await first<Test | null>(l => b.test(app.id, test.id, l));
    expect(t).toMatchObject({ name: 'Log in', description: 'Signs in', startUrl: 'https://app.example.com/signin', currentVersion: 1 });
    const v = await b.updateTestDetails(app.id, test.id, { name: 'Log in', description: 'Signs in', startUrl: 'https://app.example.com/login?next=home' });
    expect(v).toMatchObject({ number: 2 });
    expect(v?.steps.map(s => s.id)).toEqual(['s1', 's2']);
    t = await first<Test | null>(l => b.test(app.id, test.id, l));
    expect(t).toMatchObject({ startUrl: 'https://app.example.com/login?next=home', currentVersion: 2, stepCount: 2 });
    const file = fromFileText<{ version: number; startUrl: string; description?: string }>((await read(st, 'apps/web-app/tests/log-in.json'))!);
    expect(file).toMatchObject({ version: 2, startUrl: 'https://app.example.com/login?next=home', description: 'Signs in' });
    // An empty description is taken out; nothing changed writes nothing.
    await b.updateTestDetails(app.id, test.id, { name: 'Log in', description: ' ', startUrl: 'https://app.example.com/login?next=home' });
    expect(fromFileText<object>((await read(st, 'apps/web-app/tests/log-in.json'))!)).not.toHaveProperty('description');
    const write = vi.spyOn(st, 'write');
    expect(await b.updateTestDetails(app.id, test.id, { name: 'Log in', startUrl: 'https://app.example.com/login?next=home' })).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('writes a temp file and renames it into place', async () => {
    const { st, b } = await setup();
    const write = vi.spyOn(st, 'write'), rename = vi.spyOn(st, 'rename');
    await b.addApp({ name: 'Admin', baseUrl: 'https://admin.example.com', defaultViewport: VP });
    const tmp = write.mock.calls[0][0];
    expect(tmp).toMatch(/\/apps\/admin\/app\.json\.bp-\w+\.tmp$/);
    expect(rename).toHaveBeenCalledWith(tmp, `${ROOT}/apps/admin/app.json`);
    expect(await st.exists(tmp)).toBe(false);
  });

  it('keeps the last run of each test, and derives the test’s last run from it', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const base: Omit<Run, 'id'> = { appId: app.id, testId: test.id, testName: 'Log in', testVersion: 1, startedBy: ana, machine: 'This Mac', source: 'desktop', startedAt: Date.UTC(2026, 8, 25, 10), durationMs: 4200, result: 'pass', healedCount: 0, steps: [{ stepId: 's1', result: 'passed' }] };
    const r1 = await b.addRun(base);
    expect(r1.id).toBe('log-in-20260925-100000');
    const r2 = await b.addRun({ ...base, startedAt: Date.UTC(2026, 8, 25, 11), result: 'fail', steps: [{ stepId: 's1', result: 'failed', reason: 'targetNotFound' }] });
    expect(await b.run(app.id, r1.id)).toBeNull();
    expect(await b.run(app.id, r2.id)).toMatchObject({ result: 'fail', appId: 'web-app', testId: 'log-in' });
    expect(await first<Run[]>(l => b.testRuns(app.id, test.id, l))).toHaveLength(1);
    expect((await first<Test | null>(l => b.test(app.id, test.id, l)))?.lastRun).toEqual({ result: 'fail', at: Date.UTC(2026, 8, 25, 11), by: 'Ana Ruiz' });
    expect(await read(st, 'apps/web-app/runs/log-in.json')).toContain('"startedAt": "2026-09-25T11:00:00.000Z"');
    // Deleting the test takes its run with it.
    await b.deleteTest(app.id, test.id);
    expect(await st.exists(`${ROOT}/apps/web-app/runs/log-in.json`)).toBe(false);
    expect(await first(l => b.runs(app.id, l))).toEqual([]);
  });

  it('saves shared steps and works out where they are used', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const g = await b.createGroup(app.id, 'Sign in', '', steps);
    expect(g).toMatchObject({ id: 'sign-in', currentVersion: 1, stepCount: 2, usedBy: [] });
    await b.saveTest(app.id, test.id, [{ id: 'g', action: 'group', label: 'Sign in', groupId: 'sign-in', groupVersion: 'latest' }]);
    expect((await first<{ usedBy: unknown[] }[]>(l => b.stepGroups(app.id, l)))[0].usedBy).toEqual([{ testId: 'log-in', version: 'latest' }]);
    const write = vi.spyOn(st, 'write');
    expect((await b.saveGroup(app.id, g.id, steps)).number).toBe(1);
    expect(write).not.toHaveBeenCalled();
    expect((await b.saveGroup(app.id, g.id, steps.slice(0, 1))).number).toBe(2);
    expect((await b.groupVersion(app.id, g.id, 1))?.steps).toHaveLength(1);
    expect(fromFileText<{ version: number }>((await read(st, 'apps/web-app/shared/sign-in.json'))!).version).toBe(2);
  });

  it('saves suites and leaves an unchanged suite alone', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const s = await b.saveSuite(null, { name: 'Smoke', tests: [{ appId: app.id, testId: test.id }], schedule: null });
    expect(s.id).toBe('smoke');
    const text = await read(st, 'suites/smoke.json');
    expect(text).toContain('"tests": [\n    {\n      "appId": "web-app",\n      "testId": "log-in"\n    }\n  ]');
    expect(text).not.toContain('schedule');
    const write = vi.spyOn(st, 'write');
    await b.saveSuite('smoke', { name: 'Smoke', tests: [{ appId: app.id, testId: test.id }], schedule: null });
    expect(write).not.toHaveBeenCalled();
    await b.addSuiteRun({ suiteId: 'smoke', suiteName: 'Smoke', result: 'passed', counts: { total: 1, passed: 1, fixed: 0, failed: 0, notRun: 0 }, testRunIds: [], requestedBy: 'Ana Ruiz', startedAt: 1, finishedAt: 2 });
    expect((await first<{ lastRun?: unknown }[]>(l => b.suites(l)))[0].lastRun).toEqual({ result: 'passed', at: 1, by: 'Ana Ruiz' });
    await b.deleteSuite('smoke');
    expect(await first(l => b.suites(l))).toEqual([]);
  });

  it('keeps a suite\'s retries, and keeps them when a save leaves them out (roadmap #14)', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const tests = [{ appId: app.id, testId: test.id }];
    await b.saveSuite(null, { name: 'Smoke', tests, schedule: null, retries: 2 });
    expect(await read(st, 'suites/smoke.json')).toContain('"retries": 2');
    await b.saveSuite('smoke', { name: 'Smoke', tests, schedule: null });
    expect((await first<{ retries?: number }[]>(l => b.suites(l)))[0].retries).toBe(2);
    await b.saveSuite('smoke', { name: 'Smoke', tests, schedule: null, retries: 0 });
    expect((await first<{ retries?: number }[]>(l => b.suites(l)))[0].retries).toBe(0);
    st.poke(`${ROOT}/suites/odd.json`, toFileText({ name: 'Odd', tests, retries: 9 }));
    const reopened = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false });
    opened.push(reopened);
    const suites = await first<{ id: string; retries?: number }[]>(l => reopened.suites(l));
    expect(suites.find(x => x.id === 'odd')?.retries).toBeUndefined();     // not 0 to 2: the default
    expect(suites.find(x => x.id === 'smoke')?.retries).toBe(0);
  });

  it('keeps a run\'s tries and each earlier try on its step, and the Flaky answer in the test file', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.saveTest(app.id, test.id, steps);
    await b.addRun({ appId: app.id, testId: test.id, testName: 'Log in', testVersion: 1, startedBy: ana, machine: 'This Mac', source: 'desktop', startedAt: 5, durationMs: 9000,
      result: 'pass', healedCount: 0, attempts: 2, steps: [{ stepId: 's2', result: 'passed', retried: [{ attempt: 1, reason: 'timeout', durationMs: 4000 }] }] });
    const [run] = await first<Run[]>(l => b.testRuns(app.id, test.id, l));
    expect(run).toMatchObject({ attempts: 2, steps: [{ stepId: 's2', retried: [{ attempt: 1, reason: 'timeout' }] }] });
    const before = await read(st, 'apps/web-app/tests/log-in.json');
    const updatedAt = fromFileText<{ updatedAt: number }>(before!).updatedAt;
    await b.setFlakyMark(app.id, test.id, { state: 'known', version: 1, by: 'Ana Ruiz', at: Date.UTC(2026, 9, 1) });
    const text = (await read(st, 'apps/web-app/tests/log-in.json'))!;
    expect(text).toContain('"flakyMark": {');
    expect(text).toContain('"at": "2026-10-01T00:00:00.000Z"');
    expect(fromFileText<{ updatedAt: number }>(text).updatedAt).toBe(updatedAt);          // not an edit
    expect((await first<Test | null>(l => b.test(app.id, test.id, l)))?.flakyMark).toEqual({ state: 'known', version: 1, by: 'Ana Ruiz', at: Date.UTC(2026, 9, 1) });
    await b.setFlakyMark(app.id, test.id, null);
    expect(await read(st, 'apps/web-app/tests/log-in.json')).not.toContain('flakyMark');
  });

  it('keeps a schedule and where the result goes in the suite, and the address only on this Mac', async () => {
    const { st } = await setup();
    const { resultAddresses } = await import('../../platform');
    const b = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false, addresses: resultAddresses });
    opened.push(b);
    const { app, test } = await appWithTest(b);
    const url = 'https://hooks.slack.com/services/T0/B0/secret';
    const s = await b.saveSuite(null, {
      name: 'Nightly', tests: [{ appId: app.id, testId: test.id }], schedule: { days: ['fri', 'mon', 'xyz' as never], time: '06:00' },
      notify: { kind: 'slack', when: 'failures', url },
    });
    expect(s.schedule).toEqual({ days: ['mon', 'fri'], time: '06:00' });
    const text = (await read(st, 'suites/nightly.json'))!;
    expect(fromFileText<Record<string, unknown>>(text)).toMatchObject({ schedule: { days: ['mon', 'fri'], time: '06:00' }, notify: { kind: 'slack', when: 'failures' } });
    expect(text).not.toContain('hooks.slack.com');
    expect(await b.notify.address('nightly')).toBe(url);
    const [back] = await first<{ schedule: unknown; notify?: unknown }[]>(l => b.suites(l));
    expect(back).toMatchObject({ schedule: { days: ['mon', 'fri'], time: '06:00' }, notify: { kind: 'slack', when: 'failures' } });
    // Saved again without a new address: the address stays; nowhere: it goes.
    await b.saveSuite('nightly', { name: 'Nightly', tests: s.tests, schedule: null, notify: { kind: 'slack', when: 'every' } });
    expect(await b.notify.address('nightly')).toBe(url);
    await b.saveSuite('nightly', { name: 'Nightly', tests: s.tests, schedule: null, notify: null });
    expect(await b.notify.address('nightly')).toBeNull();
    expect(await read(st, 'suites/nightly.json')).not.toContain('notify');
  });

  it('keeps no address at all without the edition’s store (Community)', async () => {
    const { b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.saveSuite(null, { name: 'Nightly', tests: [{ appId: app.id, testId: test.id }], schedule: null, notify: { kind: 'slack', when: 'every', url: 'https://hooks.slack.com/services/T/B/x' } });
    expect(await b.notify.address('nightly')).toBeNull();
  });

  it('comes back the same after reopening the folder', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.saveTest(app.id, test.id, steps);
    b.close();
    const again = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false });
    opened.push(again);
    const t = await first<Test | null>(l => again.test(app.id, test.id, l));
    expect(t).toMatchObject({ name: 'Log in', currentVersion: 1, stepCount: 2 });
    expect((await again.version(app.id, test.id, 1))?.steps.map(s => s.label)).toEqual(['Go to the login page', 'Click Log in']);
  });

  it('survives a reload in the preview with persisted memory storage', async () => {
    const key = 'test.previewFiles';
    const st = new MemoryStorage({ persistKey: key });
    await st.mkdir(ROOT); await initFolder(st, ROOT);
    const b = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false });
    const { app, test } = await appWithTest(b);
    await b.saveTest(app.id, test.id, steps);
    b.close();
    const reloaded = new MemoryStorage({ persistKey: key });
    const b2 = await LocalBackend.open({ storage: reloaded, path: ROOT, person: ana, live: false });
    opened.push(b2);
    expect((await b2.version(app.id, test.id, 1))?.steps).toHaveLength(2);
    localStorage.removeItem(key);
  });

  it('picks up outside edits, skips broken or unknown files and says so', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const seen: Test[][] = [];
    const warnings: string[][] = [];
    b.tests(app.id, v => seen.push(v));
    b.onWarnings(w => warnings.push(w));
    await b.reload();
    await Promise.resolve();
    const n = seen.length;
    await b.reload();   // nothing changed on disk: no new value
    expect(seen.length).toBe(n);

    // A `git pull` renamed the test and added one.
    const path = `apps/web-app/tests/log-in.json`;
    const file = fromFileText<Record<string, unknown>>((await read(st, path))!);
    st.poke(`${ROOT}/${path}`, toFileText({ ...file, name: 'Log in (pulled)' }));
    st.poke(`${ROOT}/apps/web-app/tests/sign-up.json`, toFileText({ name: 'Sign up', startUrl: 'https://app.example.com/signup', steps: [] }));
    st.poke(`${ROOT}/apps/web-app/tests/broken.json`, '{ "name": ');
    st.poke(`${ROOT}/apps/web-app/tests/notes.md`, 'not ours');
    st.poke(`${ROOT}/apps/web-app/tests/log-in.json.bp-abc123.tmp`, 'half written');
    st.poke(`${ROOT}/apps/stray/readme.txt`, 'no app.json here');
    st.poke(`${ROOT}/suites/odd.json`, '[1, 2]');
    await b.reload();
    await Promise.resolve();
    const last = seen.at(-1)!;
    expect(last.map(t => t.name)).toEqual(['Log in (pulled)', 'Sign up']);
    expect(last[1]).toMatchObject({ id: 'sign-up', viewport: VP, status: 'draft', currentVersion: 0 });
    expect(warnings.at(-1)).toEqual([
      'apps/stray: no app.json, skipped',
      'apps/web-app/tests/broken.json: not valid JSON, skipped',
      'suites/odd.json: not a Breakpatch file, skipped',
    ]);
    // The app keeps working next to the broken file.
    expect((await b.saveTest(app.id, test.id, steps)).number).toBe(1);
  });

  it('turns read-only when breakpatch.json says a newer app saved there', async () => {
    const { st, b } = await setup();
    const ro: boolean[] = [];
    b.onReadOnly(v => ro.push(v));
    st.poke(`${ROOT}/breakpatch.json`, toFileText({ format: 'breakpatch', schemaVersion: 9, name: 'tests' }));
    await b.reload();
    expect(ro).toEqual([false, true]);
    await expect(b.addApp({ name: 'X', baseUrl: 'x', defaultViewport: VP })).rejects.toThrow(NEWER_MESSAGE);
  });

  it('watches the folder when the storage can', async () => {
    const st = new MemoryStorage();
    await st.mkdir(ROOT); await initFolder(st, ROOT);
    const b = await LocalBackend.open({ storage: st, path: ROOT, person: ana });
    opened.push(b);
    const names: string[][] = [];
    b.apps(a => names.push(a.map(x => x.name)));
    await st.mkdir(`${ROOT}/apps/admin`);
    await st.write(`${ROOT}/apps/admin/app.json`, toFileText({ name: 'Admin', baseUrl: 'https://admin.example.com' }));
    await vi.waitFor(() => expect(names.at(-1)).toEqual(['Admin']), { timeout: 2000 });
  });

  it('deletes an app with everything in it', async () => {
    const { st, b } = await setup();
    const { app } = await appWithTest(b);
    await b.deleteApp(app.id);
    expect(await st.exists(`${ROOT}/apps/web-app`)).toBe(false);
    expect(await first(l => b.apps(l))).toEqual([]);
  });
});

describe('Recently deleted', () => {
  const bin = (b: LocalBackend, appId?: string) => first<DeletedItem[]>(l => b.recentlyDeleted.items(l, appId));
  const entries = async (st: MemoryStorage) => (await st.list(`${ROOT}/deleted`)).map(e => e.name);

  it('moves a deleted test and its last run into deleted/, and puts them back', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.saveTest(app.id, test.id, steps);
    await b.addRun({ appId: app.id, testId: test.id, testName: 'Log in', testVersion: 1, startedBy: ana, machine: 'This Mac', source: 'desktop', startedAt: Date.UTC(2026, 8, 25, 10), durationMs: 1, result: 'pass', healedCount: 0, steps: [] });
    await b.deleteTest(app.id, test.id);
    expect(await first(l => b.tests(app.id, l))).toEqual([]);
    expect(await st.exists(`${ROOT}/apps/web-app/tests/log-in.json`)).toBe(false);
    const [entry] = await entries(st);
    expect(entry).toMatch(/^\d{8}-\d{6}-test-web-app-log-in$/);
    expect(await read(st, `deleted/${entry}/apps/web-app/tests/log-in.json`)).toContain('"name": "Log in"');
    expect(await read(st, `deleted/${entry}/apps/web-app/runs/log-in.json`)).toContain('"result": "pass"');
    expect(fromFileText<Record<string, unknown>>((await read(st, `deleted/${entry}/deleted.json`))!)).toMatchObject({ kind: 'test', id: 'log-in', appId: 'web-app', name: 'Log in', deletedBy: { name: 'Ana Ruiz' } });
    const items = await bin(b);
    expect(items).toMatchObject([{ kind: 'test', id: 'log-in', appId: 'web-app', appName: 'Web app', name: 'Log in', deletedBy: { name: 'Ana Ruiz' }, status: 'draft' }]);
    expect(await bin(b, 'other')).toEqual([]);
    await b.recentlyDeleted.restore(items[0]);
    expect(await first<Test[]>(l => b.tests(app.id, l))).toMatchObject([{ id: 'log-in', stepCount: 2, lastRun: { result: 'pass' } }]);
    expect(await entries(st)).toEqual([]);
    expect(await bin(b)).toEqual([]);
  });

  it('keeps an app with its tests and shared steps, which come back with it', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.createGroup(app.id, 'Sign in', '', steps);
    await b.deleteTest(app.id, test.id);
    await b.deleteApp(app.id);
    expect(await first(l => b.apps(l))).toEqual([]);
    // The app's own deleted test waits inside it.
    expect((await bin(b)).map(i => i.kind)).toEqual(['app']);
    await b.recentlyDeleted.restore({ kind: 'app', id: app.id });
    expect(await first<{ id: string }[]>(l => b.stepGroups(app.id, l))).toMatchObject([{ id: 'sign-in' }]);
    expect((await bin(b)).map(i => `${i.kind}:${i.id}`)).toEqual(['test:log-in']);
    // Deleted for good: the app, and what was deleted in it.
    await b.deleteApp(app.id);
    await b.recentlyDeleted.deleteNow({ kind: 'app', id: app.id });
    expect(await entries(st)).toEqual([]);
    expect(await bin(b)).toEqual([]);
  });

  it('restores under a new id when something else took its place, and not without its app', async () => {
    const { b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.deleteTest(app.id, test.id);
    await b.createTest({ appId: app.id, name: 'Log in', startUrl: 'https://app.example.com/login', viewport: VP });
    await b.recentlyDeleted.restore({ kind: 'test', id: test.id, appId: app.id });
    expect((await first<Test[]>(l => b.tests(app.id, l))).map(t => t.id)).toEqual(['log-in', 'log-in-2']);
    await b.deleteTest(app.id, 'log-in-2');
    await b.deleteApp(app.id);
    await expect(b.recentlyDeleted.restore({ kind: 'test', id: 'log-in-2', appId: app.id })).rejects.toThrow('Restore the app first');
    await expect(b.recentlyDeleted.restore({ kind: 'suite', id: 'nope' })).rejects.toThrow('no longer in Recently deleted');
  });

  it('keeps a deleted suite and shared steps, and deletes them for good on Delete now', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.saveSuite(null, { name: 'Smoke', tests: [{ appId: app.id, testId: test.id }], schedule: null });
    const g = await b.createGroup(app.id, 'Sign in', '', steps);
    await b.deleteSuite('smoke');
    await b.deleteGroup(app.id, g.id);
    expect(await first(l => b.suites(l))).toEqual([]);
    expect(await first(l => b.stepGroups(app.id, l))).toEqual([]);
    expect((await bin(b)).map(i => i.kind).sort()).toEqual(['group', 'suite']);
    await b.recentlyDeleted.restore({ kind: 'suite', id: 'smoke' });
    expect(await first<{ tests: unknown[] }[]>(l => b.suites(l))).toMatchObject([{ id: 'smoke', tests: [{ appId: 'web-app', testId: 'log-in' }] }]);
    await b.recentlyDeleted.deleteNow({ kind: 'group', id: g.id, appId: app.id });
    expect(await entries(st)).toEqual([]);
  });

  it('keeps a deleted suite’s result address with it: a new suite of the same name doesn’t get it, and restoring puts it back', async () => {
    const kept = new Map<string, string>();
    const addresses = {
      async get(ws: string, id: string) { return kept.get(`${ws}/${id}`) ?? null; },
      async set(ws: string, id: string, url: string | null) { if (url) kept.set(`${ws}/${id}`, url); else kept.delete(`${ws}/${id}`); },
    };
    const { st: folder } = await setup();
    const b = await LocalBackend.open({ storage: folder, path: ROOT, person: ana, live: false, addresses });
    opened.push(b);
    const { app, test } = await appWithTest(b);
    const tests = [{ appId: app.id, testId: test.id }];
    const url1 = 'https://hooks.slack.com/services/T0/B0/first', url2 = 'https://hooks.slack.com/services/T0/B0/second';
    await b.saveSuite(null, { name: 'Smoke', tests, schedule: null, notify: { kind: 'slack', when: 'every', url: url1 } });
    await b.deleteSuite('smoke');
    // Made again with the same name: the same id, none of the old one's address.
    await b.saveSuite(null, { name: 'Smoke', tests, schedule: null });
    expect(await b.notify.address('smoke')).toBeNull();
    await b.recentlyDeleted.restore({ kind: 'suite', id: 'smoke' });
    expect(await b.notify.address('smoke-2')).toBe(url1);
    expect(await b.notify.address('smoke')).toBeNull();
    // The new one with an address of its own, deleted and restored: each keeps its own.
    await b.saveSuite('smoke', { name: 'Smoke', tests, schedule: null, notify: { kind: 'slack', when: 'every', url: url2 } });
    await b.deleteSuite('smoke-2');
    await b.saveSuite(null, { name: 'Smoke 2', tests, schedule: null });
    await b.recentlyDeleted.restore({ kind: 'suite', id: 'smoke-2' });
    expect(await b.notify.address('smoke')).toBe(url2);
    expect(await b.notify.address('smoke-2')).toBeNull();
    expect(await b.notify.address('smoke-3')).toBe(url1);
    // Deleted for good: its address goes, the others stay.
    await b.deleteSuite('smoke-3');
    await b.recentlyDeleted.deleteNow({ kind: 'suite', id: 'smoke-3' });
    expect([...kept.values()]).toEqual([url2]);
  });

  it('gives an app restored under a new id its own deleted tests and shared steps', async () => {
    const { b } = await setup();
    const { app, test } = await appWithTest(b);
    const g = await b.createGroup(app.id, 'Sign in', '', steps);
    await b.deleteTest(app.id, test.id);
    await b.deleteGroup(app.id, g.id);
    await b.deleteApp(app.id);
    // Another app takes its id, and deletes a test of its own.
    const other = await b.addApp({ name: 'Web app', baseUrl: 'https://other.example.com', defaultViewport: VP });
    expect(other.id).toBe(app.id);
    const mine = await b.createTest({ appId: other.id, name: 'Other test', startUrl: 'https://other.example.com', viewport: VP });
    await b.deleteTest(other.id, mine.id);
    await b.recentlyDeleted.restore({ kind: 'app', id: app.id });
    const apps = await first<{ id: string; baseUrl: string }[]>(l => b.apps(l));
    const restored = apps.find(a => a.baseUrl === 'https://app.example.com')!;
    expect(restored.id).toBe('web-app-2');
    expect((await bin(b, restored.id)).map(i => `${i.kind}:${i.id}`).sort()).toEqual(['group:sign-in', 'test:log-in']);
    expect((await bin(b, other.id)).map(i => `${i.kind}:${i.id}`)).toEqual(['test:other-test']);
    await b.recentlyDeleted.restore({ kind: 'test', id: test.id, appId: restored.id });
    await b.recentlyDeleted.restore({ kind: 'group', id: g.id, appId: restored.id });
    expect(await first<Test[]>(l => b.tests(restored.id, l))).toMatchObject([{ id: 'log-in', name: 'Log in' }]);
    expect(await first<{ id: string }[]>(l => b.stepGroups(restored.id, l))).toMatchObject([{ id: 'sign-in' }]);
  });

  it('deletes what has been there 30 days for good when the folder is opened', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    await b.deleteTest(app.id, test.id);
    await b.deleteApp(app.id);
    const [old] = await entries(st);
    b.close();
    const later = Date.now() + KEEP_DELETED_MS - 60_000;
    const again = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false, now: () => later });
    opened.push(again);
    expect(await entries(st)).toHaveLength(2);
    again.close();
    const reopened = await LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false, now: () => later + 120_000 });
    opened.push(reopened);
    expect(await entries(st)).toEqual([]);
    expect(old).toBeTruthy();
  });

  it('skips a deleted.json it cannot use and says so', async () => {
    const { b } = await setup({ 'deleted/x/deleted.json': toFileText({ kind: 'robot', id: 'x', name: 'X' }) });
    expect(await bin(b)).toEqual([]);
    expect(await first<string[]>(l => b.onWarnings(l))).toEqual(['deleted/x/deleted.json: not a Recently deleted entry, skipped']);
  });
});

describe('reading a whole folder', () => {
  it('gives every app with its tests, shared steps, last runs and the suites, and writes nothing', async () => {
    const { st, b } = await setup();
    const { app, test } = await appWithTest(b);
    const group = await b.createGroup(app.id, 'Sign in', 'Email and password', [steps[1]]);
    await b.saveTest(app.id, test.id, [...steps, { id: 's3', action: 'group', label: 'Sign in', groupId: group.id, groupVersion: 'latest' }]);
    const run: Omit<Run, 'id'> = { appId: app.id, testId: test.id, testName: 'Log in', testVersion: 1, startedBy: ana, machine: 'Mac', source: 'desktop', startedAt: Date.UTC(2026, 8, 25, 9), durationMs: 900, result: 'pass', healedCount: 0, steps: [] };
    await b.addRun(run);
    await b.saveSuite(null, { name: 'Smoke', tests: [{ appId: app.id, testId: test.id }], schedule: null });
    const before = await st.list(`${ROOT}/apps/web-app/tests`);

    const snap = await LocalBackend.read({ storage: st, path: ROOT, person: ana });
    expect(snap).toMatchObject({ path: ROOT, name: 'tests', schemaVersion: 1, newer: false, skipped: [] });
    expect(snap.apps).toHaveLength(1);
    const a = snap.apps[0];
    expect(a.app).toMatchObject({ id: 'web-app', name: 'Web app' });
    expect(a.tests.map(t => [t.test.id, t.test.currentVersion, t.steps.length])).toEqual([['log-in', 1, 3]]);
    expect(a.tests[0].steps[1]).not.toHaveProperty('rerecorded');
    expect(a.groups.map(g => [g.group.id, g.group.usedBy])).toEqual([['sign-in', [{ testId: 'log-in', version: 'latest' }]]]);
    expect(a.runs.map(r => [r.testId, r.result])).toEqual([['log-in', 'pass']]);
    expect(snap.suites.map(s => [s.id, s.tests])).toEqual([['smoke', [{ appId: 'web-app', testId: 'log-in' }]]]);
    expect(await st.list(`${ROOT}/apps/web-app/tests`)).toEqual(before);
  });

  it('lists broken files it left out and still reads a folder from a newer app', async () => {
    const { st } = await setup({
      'apps/web-app/app.json': toFileText({ name: 'Web app', baseUrl: 'https://app.example.com' }),
      'apps/web-app/tests/ok.json': toFileText({ name: 'OK', version: 1, steps }),
      'apps/web-app/tests/broken.json': '{ "name": ',
    });
    st.poke(`${ROOT}/breakpatch.json`, toFileText({ format: 'breakpatch', schemaVersion: NEWEST_READ_SCHEMA_VERSION + 1, name: 'Later' }));
    const snap = await LocalBackend.read({ storage: st, path: ROOT, person: ana });
    expect(snap.newer).toBe(true);
    expect(snap.schemaVersion).toBe(NEWEST_READ_SCHEMA_VERSION + 1);
    expect(snap.apps[0].tests.map(t => t.test.id)).toEqual(['ok']);
    expect(snap.skipped).toEqual(['apps/web-app/tests/broken.json: not valid JSON, skipped']);
    // The texts it was read from come with it, broken ones included, so a copy can tell if the folder changed.
    expect(Object.keys(snap.files).sort()).toEqual(['apps/web-app/app.json', 'apps/web-app/tests/broken.json', 'apps/web-app/tests/ok.json', 'breakpatch.json']);
    expect(snap.files['breakpatch.json']).toContain('"Later"');
  });

  it("refuses a folder that isn't a Breakpatch folder", async () => {
    const st = new MemoryStorage();
    await st.mkdir('/x');
    await expect(LocalBackend.read({ storage: st, path: '/x', person: ana })).rejects.toMatchObject({ code: 'missing' });
  });
});

describe('file size limit', () => {
  const big = 'x'.repeat(5 * 1024 * 1024 + 1);
  it('skips a test file over 5 MB and says so', async () => {
    const { b } = await setup({ 'apps/web-app/app.json': toFileText({ name: 'Web app', baseUrl: 'https://app.example.com' }), 'apps/web-app/tests/huge.json': big });
    const snap = await b.snapshot();
    expect(snap.skipped).toContain('apps/web-app/tests/huge.json: bigger than 5 MB, skipped');
    expect(snap.files['apps/web-app/tests/huge.json']).toBe('');
  });
  it('refuses a breakpatch.json over 5 MB', async () => {
    const st = new MemoryStorage();
    await st.mkdir(ROOT);
    st.poke(`${ROOT}/breakpatch.json`, big);
    await expect(LocalBackend.open({ storage: st, path: ROOT, person: ana, live: false })).rejects.toMatchObject({ code: 'unreadable' });
    await expect(inspectFolder(st, ROOT)).rejects.toBeInstanceOf(FolderError);
  });
  it('the Mac storage checks the size before it reads', async () => {
    const calls: string[] = [];
    vi.doMock('@tauri-apps/plugin-fs', () => ({
      exists: async () => true,
      stat: async () => { calls.push('stat'); return { size: 6 * 1024 * 1024 }; },
      readTextFile: async () => { calls.push('read'); return ''; },
    }));
    vi.resetModules();
    const { TauriStorage } = await import('./tauriStorage');
    await expect(new TauriStorage().read('/x/huge.json')).rejects.toThrow('bigger than 5 MB');
    expect(calls).toEqual(['stat']);
    vi.doUnmock('@tauri-apps/plugin-fs');
  });
});

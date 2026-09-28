// Sample data for the demo backend, taken from the design files (the Acme example workspace).
import type {
  App, Member, Person, QueueItem, Run, RunnerStatus, Step, StepGroup, Suite, SuiteRun, Test, Version, Viewport,
} from '../types';

export const LAPTOP: Viewport = { width: 1440, height: 900, dpr: 1 };

export const people = {
  maria: { uid: 'u-maria', name: 'Maria Lopez', email: 'maria.lopez@acme.example' },
  tom: { uid: 'u-tom', name: 'Tom Reid', email: 'tom.reid@acme.example' },
  priya: { uid: 'u-priya', name: 'Priya Shah', email: 'priya.shah@acme.example' },
  sam: { uid: 'u-sam', name: 'Sam Okafor', email: 'sam.okafor@acme.example' },
  runner: { uid: 'u-runner', name: 'QA Mac mini', email: 'qa-runner@acme.example' },
  ci: { uid: 'u-ci', name: 'Codemagic', email: 'ci@acme.example' },
} satisfies Record<string, Person>;

const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** Today at hh:mm, minus `daysAgo` days. */
export function at(hhmm: string, daysAgo = 0): number {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.getTime() - daysAgo * DAY;
}
function dayOf(month: number, date: number): number { return new Date(new Date().getFullYear(), month - 1, date, 10, 0).getTime(); }

export function seedApps(): App[] {
  return [
    { id: 'webapp', name: 'Web app', baseUrl: 'https://app.example.com', icon: 'language', defaultViewport: LAPTOP, createdBy: people.maria, createdAt: dayOf(8, 20) },
    { id: 'console', name: 'Console', baseUrl: 'https://console.example.com', icon: 'dashboard', defaultViewport: LAPTOP, createdBy: people.tom, createdAt: dayOf(8, 22) },
    { id: 'marketing', name: 'Marketing site', baseUrl: 'https://www.example.com', icon: 'public', defaultViewport: LAPTOP, createdBy: people.priya, createdAt: dayOf(8, 25) },
  ];
}

const s = (id: string, action: Step['action'], label: string, target?: string, extra: Partial<Step> = {}): Step => ({ id, action, label, target, ...extra });

/** Steps of "Create a project", the test the prototype records and runs. */
export function createProjectSteps(): Step[] {
  return [
    s('s1', 'navigate', 'Open the home page', 'Home page of Web app', { nav: 'url', url: 'https://app.example.com' }),
    s('s2', 'group', 'Log in', 'Shared steps: Log in', { groupId: 'login', groupVersion: 'latest' }),
    s('s3', 'click', 'Click New project', 'New project button, top right', { at: [1296, 132] }),
    s('s4', 'click', 'Click Project name', 'Project name field in the Create project dialog', { at: [720, 300] }),
    s('s5', 'write', 'Write "Test project {time}"', 'Project name field', { text: 'Test project {time}' }),
    s('s6', 'click', 'Click Done', 'Done button, bottom right of the Create project dialog', { at: [920, 634] }),
    s('s7', 'checkpoint', 'Success message shows', 'Green message at the top', { region: [560, 24, 880, 72] }),
    s('s8', 'waitFor', 'Wait 2 seconds', undefined, { durationMs: 2000 }),
  ];
}

export function loginSteps(): Step[] {
  return [
    s('g1', 'click', 'Click Email', 'Email field on the sign-in page', { at: [720, 380] }),
    s('g2', 'write', 'Write saved secret ACME_TEST_EMAIL', 'Email field', { secretRef: 'ACME_TEST_EMAIL' }),
    s('g3', 'click', 'Click Password', 'Password field', { at: [720, 450] }),
    s('g4', 'write', 'Write saved secret ACME_TEST_PASSWORD', 'Password field', { secretRef: 'ACME_TEST_PASSWORD' }),
    s('g5', 'click', 'Click Log in', 'Log in button under the password', { at: [720, 520] }),
  ];
}

function genericSteps(n: number, name: string): Step[] {
  const out: Step[] = [s('x0', 'navigate', 'Open the home page', 'Home page', { nav: 'url' })];
  for (let i = 1; i < n; i++) out.push(s('x' + i, i % 3 === 2 ? 'write' : 'click', i % 3 === 2 ? `Write "${name} ${i}"` : `Click step ${i}`, 'Item on the page', { at: [400 + i * 40, 300 + i * 20] }));
  return out;
}

type TSeed = [string, string, number, boolean, 'pass' | 'healed' | 'fail' | null, number | null, Person, number, Person, number];

export function seedTests(): { tests: Test[]; versions: Record<string, Version[]> } {
  const rows: TSeed[] = [
    ['webapp', 'Create a project', 8, true, 'healed', at('14:52'), people.maria, dayOf(9, 2), people.maria, at('14:40')],
    ['webapp', 'Log in and out', 6, true, 'pass', at('06:00'), people.tom, dayOf(8, 28), people.tom, dayOf(9, 12)],
    ['webapp', 'Upload a file (PDF)', 11, true, 'fail', at('06:00'), people.tom, dayOf(8, 30), people.priya, at('16:00', 1)],
    ['webapp', 'Invite a team member', 9, true, 'pass', at('06:00'), people.priya, dayOf(9, 4), people.priya, dayOf(9, 10)],
    ['webapp', 'Filter notes by tag', 7, true, 'pass', at('06:00'), people.maria, dayOf(9, 5), people.maria, dayOf(9, 5)],
    ['webapp', 'Export a report', 10, true, 'pass', at('06:00'), people.tom, dayOf(9, 6), people.tom, dayOf(9, 15)],
    ['webapp', 'Create 5 notes (repeat)', 5, true, 'pass', at('06:00'), people.priya, dayOf(9, 8), people.maria, dayOf(9, 18)],
    ['webapp', 'Check CSV download', 6, false, 'pass', at('11:20', 1), people.maria, dayOf(9, 19), people.maria, dayOf(9, 19)],
    ['webapp', 'Archive a project', 7, false, null, null, people.tom, at('09:00'), people.tom, at('10:05')],
    ['marketing', 'Home page loads', 2, true, 'pass', at('06:00'), people.priya, dayOf(8, 26), people.priya, dayOf(8, 26)],
    ['marketing', 'Contact form sends', 5, true, 'pass', at('06:00'), people.priya, dayOf(8, 26), people.priya, dayOf(9, 1)],
    ['marketing', 'Pricing page', 3, true, 'pass', at('06:00'), people.sam, dayOf(9, 3), people.sam, dayOf(9, 3)],
    ['marketing', 'Blog search', 4, true, 'pass', at('06:00'), people.sam, dayOf(9, 3), people.sam, dayOf(9, 9)],
  ];
  const tests: Test[] = [];
  const versions: Record<string, Version[]> = {};
  rows.forEach(([appId, name, n, pub, last, lastAt, cBy, cAt, uBy, uAt], i) => {
    const id = i === 0 ? 'create-project' : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '');
    const steps = i === 0 ? createProjectSteps() : genericSteps(n, name);
    const vCount = i === 0 ? 7 : 1 + (i % 5);
    const vs: Version[] = [];
    for (let v = 1; v <= vCount; v++) {
      const vSteps = i === 0 && v < vCount ? steps.slice(0, Math.max(3, steps.length - (vCount - v))) : steps;
      vs.push({ number: v, steps: vSteps, savedBy: v === vCount ? uBy : [people.maria, people.tom, people.priya][v % 3], savedAt: uAt - (vCount - v) * 2 * DAY, note: VERSION_NOTES[(v + i) % VERSION_NOTES.length] });
    }
    versions[`${appId}/${id}`] = vs;
    tests.push({
      id, appId, name, startUrl: appId === 'webapp' ? 'https://app.example.com' : 'https://www.example.com',
      status: pub ? 'published' : 'draft', viewport: LAPTOP, currentVersion: vCount, stepCount: steps.length,
      lastRun: last && lastAt ? { result: last, at: lastAt, by: last === 'healed' ? 'Maria Lopez' : 'Nightly suite' } : undefined,
      createdBy: cBy, createdAt: cAt, updatedBy: uBy, updatedAt: uAt,
    });
  });
  return { tests, versions };
}

const VERSION_NOTES = ['Updated Done button after redesign', 'Added success check', 'Renamed steps', 'Wait for the list to load', 'Re-recorded the login', 'First version'];

export function seedGroups(): { groups: StepGroup[]; versions: Record<string, Version[]> } {
  const login = loginSteps();
  return {
    groups: [
      { id: 'login', appId: 'webapp', name: 'Log in', description: 'Signs in with the test account', currentVersion: 3, stepCount: login.length,
        usedBy: [{ testId: 'create-project', version: 'latest' }, { testId: 'log-in-and-out', version: 'latest' }, { testId: 'upload-a-file-pdf', version: 2 }, { testId: 'invite-a-team-member', version: 'latest' }, { testId: 'filter-notes-by-tag', version: 'latest' }, { testId: 'export-a-report', version: 'latest' }, { testId: 'create-5-notes-repeat', version: 'latest' }, { testId: 'check-csv-download', version: 3 }, { testId: 'archive-a-project', version: 'latest' }],
        createdBy: people.tom, createdAt: dayOf(8, 21), updatedBy: people.tom, updatedAt: dayOf(9, 12) },
      { id: 'open-project', appId: 'webapp', name: 'Open a project', description: 'Opens the first project in the list', currentVersion: 2, stepCount: 3, usedBy: [{ testId: 'upload-a-file-pdf', version: 'latest' }, { testId: 'export-a-report', version: 'latest' }, { testId: 'archive-a-project', version: 'latest' }],
        createdBy: people.maria, createdAt: dayOf(8, 29), updatedBy: people.priya, updatedAt: dayOf(9, 14) },
      { id: 'logout', appId: 'webapp', name: 'Log out', description: 'Signs out from the avatar menu', currentVersion: 1, stepCount: 2, usedBy: [{ testId: 'log-in-and-out', version: 'latest' }],
        createdBy: people.tom, createdAt: dayOf(8, 28), updatedBy: people.tom, updatedAt: dayOf(8, 28) },
    ],
    versions: {
      'webapp/login': [1, 2, 3].map(n => ({ number: n, steps: login, savedBy: people.tom, savedAt: dayOf(9, 12) - (3 - n) * 4 * DAY, note: n === 3 ? 'New sign-in page' : undefined })),
      'webapp/open-project': [1, 2].map(n => ({ number: n, steps: genericSteps(3, 'Open'), savedBy: people.priya, savedAt: dayOf(9, 14) - (2 - n) * DAY })),
      'webapp/logout': [{ number: 1, steps: genericSteps(2, 'Logout'), savedBy: people.tom, savedAt: dayOf(8, 28) }],
    },
  };
}

type RSeed = [string, 'pass' | 'healed' | 'fail', number, Person | 'nightly', 'desktop' | 'runner' | 'ci', number, number];

export function seedRuns(tests: Test[]): Run[] {
  const byName = (n: string) => tests.find(t => t.name === n)!;
  const rows: RSeed[] = [
    ['Create a project', 'healed', at('14:52'), people.maria, 'desktop', 7, 68],
    ['Check CSV download', 'pass', at('11:20'), people.maria, 'desktop', 2, 41],
    ['Upload a file (PDF)', 'fail', at('06:00'), 'nightly', 'runner', 4, 37],
    ['Log in and out', 'pass', at('06:00'), 'nightly', 'runner', 3, 22],
    ['Invite a team member', 'pass', at('06:00'), 'nightly', 'runner', 5, 49],
    ['Filter notes by tag', 'pass', at('06:00'), 'nightly', 'runner', 1, 31],
    ['Export a report', 'pass', at('06:00'), 'nightly', 'runner', 6, 55],
    ['Create 5 notes (repeat)', 'pass', at('06:00'), 'nightly', 'runner', 4, 134],
    ['Create a project', 'pass', at('06:00'), 'nightly', 'runner', 7, 58],
    ['Log in and out', 'pass', at('16:21', 1), people.tom, 'desktop', 3, 24],
    ['Create a project', 'fail', at('06:00', 1), 'nightly', 'ci', 6, 44],
  ];
  return rows.map(([name, result, startedAt, who, source, v, secs], i) => {
    const t = byName(name);
    const steps = t.id === 'create-project'
      ? createProjectSteps().map((st, k) => ({
          stepId: st.id,
          result: result === 'fail' ? (k < 5 ? 'passed' : k === 5 ? 'failed' : 'notRun') : result === 'healed' && k === 5 ? 'healed' : 'passed',
          reason: result === 'fail' && k === 5 ? 'targetNotFound' : undefined,
          oldAt: result === 'healed' && k === 5 ? [1209, 662] : undefined,
          newAt: result === 'healed' && k === 5 ? [1180, 700] : undefined,
        } as Run['steps'][number]))
      : Array.from({ length: t.stepCount }, (_, k) => ({ stepId: 'x' + k, result: result === 'fail' ? (k < 6 ? 'passed' : k === 6 ? 'failed' : 'notRun') : 'passed', reason: result === 'fail' && k === 6 ? 'unexpectedScreen' : undefined } as Run['steps'][number]));
    return {
      id: 'run-' + (100 + i), appId: t.appId, testId: t.id, testName: t.name, testVersion: v,
      startedBy: who === 'nightly' ? { serviceAccount: 'Nightly suite' } : who,
      machine: source === 'desktop' ? (who as Person).name.split(' ')[0] + "'s MacBook Pro" : source === 'runner' ? 'QA Mac mini' : 'Codemagic M2',
      source, startedAt, durationMs: secs * 1000, result: result === 'fail' ? 'fail' : 'pass', healedCount: result === 'healed' ? 1 : 0, steps,
    };
  });
}

// Suites point at tests that exist in the seed, so the editor and the demo runner can open them.
const ref = (appId: string) => (testId: string) => ({ appId, testId });
const WEBAPP_TESTS = ['create-project', 'log-in-and-out', 'upload-a-file-pdf', 'invite-a-team-member', 'filter-notes-by-tag', 'export-a-report', 'create-5-notes-repeat', 'check-csv-download', 'archive-a-project'].map(ref('webapp'));
const MARKETING_TESTS = ['home-page-loads', 'contact-form-sends', 'pricing-page', 'blog-search'].map(ref('marketing'));

export function seedSuites(): Suite[] {
  const base = { createdBy: people.maria, createdAt: dayOf(9, 1), updatedBy: people.maria, updatedAt: dayOf(9, 15) };
  return [
    { id: 'smoke-7f3a', name: 'Smoke', schedule: null, resultUrl: 'https://hooks.example.com/breakpatch/smoke',
      tests: [['webapp', 'log-in-and-out'], ['webapp', 'create-project'], ['webapp', 'upload-a-file-pdf'], ['webapp', 'invite-a-team-member'], ['marketing', 'home-page-loads'], ['marketing', 'contact-form-sends']].map(([appId, testId]) => ({ appId, testId })),
      lastRun: { result: 'passed', at: at('14:10'), by: 'Codemagic' }, ...base },
    { id: 'nightly-2c91', name: 'Nightly', schedule: { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], time: '02:00' }, resultUrl: 'https://hooks.example.com/breakpatch/nightly',
      tests: [...WEBAPP_TESTS, ...MARKETING_TESTS], lastRun: { result: 'passed_with_fixes', at: at('02:00', 1), by: 'Schedule' }, ...base },
    { id: 'release-b810', name: 'Release check', schedule: { days: ['mon', 'tue', 'wed', 'thu', 'fri'], time: '06:00' }, resultUrl: 'https://hooks.example.com/breakpatch/release',
      tests: WEBAPP_TESTS, lastRun: { result: 'failed', at: at('06:00', 1), by: 'Schedule' }, ...base },
  ];
}

export function seedRunner(): RunnerStatus {
  return {
    name: 'QA Mac mini', status: 'running', lastSeen: Date.now(), appVersion: '1.4.2', memoryGb: 64, model: 'Standard',
    current: { suiteId: 'nightly-2c91', suiteName: 'Nightly', test: 'Upload a file (PDF)', index: 3, total: 13, startedBy: 'Schedule', startedAt: Date.now() - 4 * MIN, passed: 2, failed: 0 },
  };
}

export function seedQueue(): QueueItem[] {
  return [
    { id: 'q1', suiteId: 'smoke-7f3a', suiteName: 'Smoke', requestedBy: 'Codemagic · build 412', source: 'request', queuedAt: at('14:52') },
    { id: 'q2', suiteId: 'release-b810', suiteName: 'Release check', requestedBy: 'Maria Lopez', source: 'button', queuedAt: at('14:55') },
  ];
}

export function seedSuiteRuns(): SuiteRun[] {
  const c = (total: number, passed: number, fixed: number, failed: number) => ({ total, passed, fixed, failed, notRun: total - passed - fixed - failed });
  return [
    { id: 'sr4', suiteId: 'smoke-7f3a', suiteName: 'Smoke', result: 'passed', counts: c(6, 6, 0, 0), testRunIds: [], requestedBy: 'Codemagic · build 411', startedAt: at('14:10'), finishedAt: at('14:14') },
    { id: 'sr3', suiteId: 'nightly-2c91', suiteName: 'Nightly', result: 'passed_with_fixes', counts: c(13, 12, 1, 0), testRunIds: [], requestedBy: 'Schedule', startedAt: at('02:00', 1), finishedAt: at('02:17', 1) },
    { id: 'sr2', suiteId: 'release-b810', suiteName: 'Release check', result: 'failed', counts: c(9, 8, 0, 1), testRunIds: [], requestedBy: 'Schedule', startedAt: at('06:00', 1), finishedAt: at('06:11', 1) },
    { id: 'sr1', suiteId: 'smoke-7f3a', suiteName: 'Smoke', result: 'replaced', counts: c(6, 2, 0, 0), testRunIds: [], requestedBy: 'Codemagic · build 409', replacedBy: 'build 410', startedAt: at('17:30', 1), finishedAt: at('17:34', 1) },
  ];
}

export function seedMembers(): Member[] {
  return [
    { ...people.maria, role: 'admin', lastActive: Date.now() },
    { ...people.tom, role: 'admin', lastActive: at('11:00') },
    { ...people.priya, role: 'member', lastActive: at('16:00', 1) },
    { ...people.sam, role: 'member', lastActive: at('10:00', 6) },
    { ...people.runner, role: 'runner', lastActive: Date.now() },
    { ...people.ci, role: 'ci', lastActive: at('14:52') },
  ];
}

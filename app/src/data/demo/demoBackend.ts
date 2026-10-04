// In-memory backend for development, the browser preview and tests.
// Behaves like the Firebase backend: live subscriptions, immutable versions, audit fields.
import { edition } from '../../edition';
import {
  AuthError, cleanDetails, detailsDiff, newestDeletedFirst, startUrlNote, upTo,
  type Backend, type DeletedItem, type DeletedRef, type Limit, type Listener, type NewApp, type NewSuite, type NewTest, type NotifyStore, type RecentlyDeleted, type RunNotes, type TestDetails, type TrackerStore, type Unsubscribe,
} from '../backend';
import type {
  App, Explanation, Member, Person, QueueItem, RecordedOn, Role, Run, RunIssue, RunnerStatus, RunRequest, Step, StepGroup, Suite, SuiteRun, Test, TestStatus, TrackerSettings, Version, Workspace,
} from '../types';
import { applyRunnerPreview, runnerPreviewFlag, type RunnerPreview } from './preview';
import { communityDemo, people, seedApps, seedGroups, seedMembers, seedQueue, seedRunner, seedRuns, seedSuiteRuns, seedSuites, seedTests } from './seed';

export const DEMO_WORKSPACE: Workspace = {
  name: 'Acme',
  logo: '/assets/logo-badge-purple.png',
  database: 'breakpatch',
  domain: 'acme.example',
  config: { apiKey: 'demo', authDomain: 'acme-qa.firebaseapp.com', projectId: 'acme-qa', appId: '1:000:web:demo' },
};

interface State {
  user: Person | null;
  apps: App[];
  tests: Test[];
  versions: Record<string, Version[]>;
  groups: StepGroup[];
  groupVersions: Record<string, Version[]>;
  runs: Run[];
  suites: Suite[];
  runner: RunnerStatus | null;
  queue: QueueItem[];
  suiteRuns: SuiteRun[];
  runRequests: RunRequest[];
  members: Member[];
  /** Recently deleted: each item with what it took along, to put back. */
  bin: Binned[];
}

/** An item in Recently deleted, with the documents it took out of the lists. */
/** `next`: for each thing taken, what came after it in its list, so restoring puts it back in its place. */
interface Binned { item: DeletedItem; apps?: App[]; tests?: Test[]; groups?: StepGroup[]; suites?: Suite[]; next?: Record<string, string> }
const LISTS = ['apps', 'tests', 'groups', 'suites'] as const;
const placeKey = (list: string, x: { id: string; appId?: string }) => `${list}:${x.appId ?? ''}/${x.id}`;
const sameRef = (a: DeletedRef, b: DeletedRef) => a.kind === b.kind && a.id === b.id && (a.appId ?? '') === (b.appId ?? '');

export interface DemoOptions { empty?: boolean; signedIn?: boolean; delayMs?: number }

let uid = 1000;
const newId = (p: string) => `${p}-${(uid++).toString(36)}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item';

export class DemoBackend implements Backend {
  readonly kind = 'demo' as const;
  readonly workspace: Workspace;
  private st: State;
  private subs = new Set<() => void>();
  private delay: number;

  constructor(opts: DemoOptions = {}, workspace: Workspace = DEMO_WORKSPACE) {
    this.workspace = workspace;
    this.delay = opts.delayMs ?? 250;
    const t = seedTests(); const g = seedGroups();
    this.st = opts.empty
      ? { user: opts.signedIn ? people.maria : null, apps: [], tests: [], versions: {}, groups: [], groupVersions: {}, runs: [], suites: [], runner: null, queue: [], suiteRuns: [], runRequests: [], members: [{ ...people.maria, role: 'admin', lastActive: Date.now() }], bin: [] }
      : { user: opts.signedIn ? people.maria : null, apps: seedApps(), tests: t.tests, versions: t.versions, groups: g.groups, groupVersions: g.versions, runs: seedRuns(t.tests), suites: seedSuites(), runner: seedRunner(), queue: seedQueue(), suiteRuns: seedSuiteRuns(), runRequests: [], members: seedMembers(), bin: [] };
    if (!opts.empty && edition.name === 'community') this.st = communityDemo(this.st);
  }

  // ---- plumbing ----
  private emit() { this.subs.forEach(f => f()); }
  private watch<T>(select: () => T, l: Listener<T>): Unsubscribe {
    let alive = true;
    const push = () => { if (alive) l(select()); };
    const t = setTimeout(push, this.delay);     // first value arrives like a network read
    this.subs.add(push);
    return () => { alive = false; clearTimeout(t); this.subs.delete(push); };
  }
  private wait<T>(v: T): Promise<T> { return new Promise(r => setTimeout(() => r(v), Math.min(this.delay, 300))); }
  private me(): Person { if (!this.st.user) throw new Error('Not signed in'); return this.st.user; }
  private mutate(fn: (s: State) => void) { fn(this.st); this.emit(); }

  // ---- auth ----
  currentUser() { return this.st.user; }
  onUser(l: Listener<Person | null>) { l(this.st.user); const f = () => l(this.st.user); this.subs.add(f); return () => { this.subs.delete(f); }; }
  async signIn(email: string, password: string) {
    await this.wait(null);
    const domain = email.split('@')[1]?.toLowerCase();
    if (domain !== this.workspace.domain) throw new AuthError('wrongDomain', `Only @${this.workspace.domain} accounts can sign in here.`);
    if (password.length < 6) throw new AuthError('wrongPassword', 'Wrong email or password.');
    const known = Object.values(people).find(p => p.email === email.toLowerCase());
    const user = known ?? { uid: 'u-' + slug(email), name: email.split('@')[0].replace(/[._]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), email };
    this.mutate(s => { s.user = user; if (!s.members.some(m => m.uid === user.uid)) s.members.push({ ...user, role: 'member', lastActive: Date.now() }); });
    return user;
  }
  async sendPasswordReset() { await this.wait(null); }
  async signOut() { this.mutate(s => { s.user = null; }); }
  myRole(): Role { return this.st.members.find(m => m.uid === this.st.user?.uid)?.role ?? 'member'; }

  // ---- apps ----
  apps(l: Listener<App[]>) { return this.watch(() => [...this.st.apps], l); }
  async addApp(a: NewApp) {
    const app: App = { id: slug(a.name) + '-' + (uid++).toString(36), ...a, icon: a.icon ?? 'language', createdBy: this.me(), createdAt: Date.now() };
    this.mutate(s => { s.apps.push(app); });
    return this.wait(app);
  }
  async updateApp(id: string, patch: Partial<NewApp>) { this.mutate(s => { s.apps = s.apps.map(a => a.id === id ? { ...a, ...patch } : a); }); }
  async deleteApp(id: string) {
    const app = this.st.apps.find(a => a.id === id);
    if (!app) return;
    this.toBin({ kind: 'app', id, name: app.name, createdBy: app.createdBy }, s => {
      const tests = s.tests.filter(t => t.appId === id), groups = s.groups.filter(g => g.appId === id);
      s.apps = s.apps.filter(a => a.id !== id); s.tests = s.tests.filter(t => t.appId !== id); s.groups = s.groups.filter(g => g.appId !== id);
      return { apps: [app], tests, groups };
    });
  }

  // ---- tests ----
  tests(appId: string, l: Listener<Test[]>) { return this.watch(() => this.st.tests.filter(t => t.appId === appId), l); }
  test(appId: string, testId: string, l: Listener<Test | null>) { return this.watch(() => this.st.tests.find(t => t.appId === appId && t.id === testId) ?? null, l); }
  async createTest(n: NewTest) {
    const me = this.me(); const now = Date.now();
    const test: Test = { id: slug(n.name) + '-' + (uid++).toString(36), appId: n.appId, name: n.name, description: n.description, startUrl: n.startUrl, viewport: n.viewport, setUp: n.setUp, cleanUp: n.cleanUp,
      status: 'draft', currentVersion: 0, stepCount: 0, createdBy: me, createdAt: now, updatedBy: me, updatedAt: now };
    this.mutate(s => { s.tests.push(test); s.versions[`${n.appId}/${test.id}`] = []; });
    return this.wait(test);
  }
  versions(appId: string, testId: string, l: Listener<Version[]>, limit?: Limit) { return this.watch(() => upTo([...(this.st.versions[`${appId}/${testId}`] ?? [])].reverse(), limit), l); }
  async version(appId: string, testId: string, n: number) { return this.wait(this.st.versions[`${appId}/${testId}`]?.find(v => v.number === n) ?? null); }
  async saveTest(appId: string, testId: string, steps: Step[], note?: string, recordedOn?: RecordedOn) {
    const me = this.me(); const key = `${appId}/${testId}`;
    const list = this.st.versions[key] ?? [];
    const startUrl = this.st.tests.find(t => t.appId === appId && t.id === testId)?.startUrl;
    const v: Version = { number: list.length + 1, steps: steps.map(x => ({ ...x, rerecorded: undefined })), savedBy: me, savedAt: Date.now(), note: note || undefined,
      recordedOn: recordedOn ?? list.at(-1)?.recordedOn, ...(startUrl ? { startUrl } : {}) };
    this.mutate(s => {
      s.versions[key] = [...list, v];
      s.tests = s.tests.map(t => t.appId === appId && t.id === testId ? { ...t, currentVersion: v.number, stepCount: steps.length, updatedBy: me, updatedAt: v.savedAt } : t);
    });
    return this.wait(v);
  }
  async setTestStatus(appId: string, testId: string, status: TestStatus) { this.patchTest(appId, testId, { status }); }
  async renameTest(appId: string, testId: string, name: string) { this.patchTest(appId, testId, { name }); }
  async updateTestDetails(appId: string, testId: string, details: TestDetails) {
    const t = this.st.tests.find(x => x.appId === appId && x.id === testId);
    if (!t) throw new Error('This test was deleted.');
    const d = cleanDetails(details);
    const { moved, changed } = detailsDiff(t, d);
    if (!changed) return this.wait(null);
    this.patchTest(appId, testId, { name: d.name, description: d.description, startUrl: d.startUrl });
    const last = moved && t.currentVersion > 0 ? this.st.versions[`${appId}/${testId}`]?.at(-1) : undefined;
    // The same steps as a new version that starts at the new address, like the Firebase backend.
    return last ? this.saveTest(appId, testId, last.steps, startUrlNote(d.startUrl), last.recordedOn) : this.wait(null);
  }
  private patchTest(appId: string, testId: string, p: Partial<Test>) {
    const me = this.me();
    this.mutate(s => { s.tests = s.tests.map(t => t.appId === appId && t.id === testId ? { ...t, ...p, updatedBy: me, updatedAt: Date.now() } : t); });
  }
  async duplicateTest(appId: string, testId: string) {
    const src = this.st.tests.find(t => t.appId === appId && t.id === testId);
    if (!src) throw new Error('Test not found');
    const copy = await this.createTest({ appId, name: src.name + ' (copy)', description: src.description, startUrl: src.startUrl, viewport: src.viewport, setUp: src.setUp, cleanUp: src.cleanUp });
    const last = this.st.versions[`${appId}/${testId}`]?.at(-1);
    if (last) await this.saveTest(appId, copy.id, last.steps, `Copied from ${src.name}`, last.recordedOn);
    return copy;
  }
  async deleteTest(appId: string, testId: string) {
    const t = this.st.tests.find(x => x.appId === appId && x.id === testId);
    if (!t) return;
    this.toBin({ kind: 'test', id: testId, appId, name: t.name, createdBy: t.createdBy, status: t.status }, s => {
      s.tests = s.tests.filter(x => x !== t);
      return { tests: [t] };
    });
  }

  // ---- shared steps ----
  stepGroups(appId: string, l: Listener<StepGroup[]>) { return this.watch(() => this.st.groups.filter(g => g.appId === appId), l); }
  groupVersions(appId: string, groupId: string, l: Listener<Version[]>, limit?: Limit) { return this.watch(() => upTo([...(this.st.groupVersions[`${appId}/${groupId}`] ?? [])].reverse(), limit), l); }
  async groupVersion(appId: string, groupId: string, n: number) { return this.wait(this.st.groupVersions[`${appId}/${groupId}`]?.find(v => v.number === n) ?? null); }
  async createGroup(appId: string, name: string, description: string, steps: Step[]) {
    const me = this.me(); const now = Date.now();
    const g: StepGroup = { id: slug(name) + '-' + (uid++).toString(36), appId, name, description, currentVersion: 1, stepCount: steps.length, usedBy: [], createdBy: me, createdAt: now, updatedBy: me, updatedAt: now };
    this.mutate(s => { s.groups.push(g); s.groupVersions[`${appId}/${g.id}`] = [{ number: 1, steps, savedBy: me, savedAt: now }]; });
    return this.wait(g);
  }
  async saveGroup(appId: string, groupId: string, steps: Step[], note?: string) {
    const me = this.me(); const key = `${appId}/${groupId}`;
    const list = this.st.groupVersions[key] ?? [];
    const v: Version = { number: list.length + 1, steps, savedBy: me, savedAt: Date.now(), note };
    this.mutate(s => {
      s.groupVersions[key] = [...list, v];
      s.groups = s.groups.map(g => g.appId === appId && g.id === groupId ? { ...g, currentVersion: v.number, stepCount: steps.length, updatedBy: me, updatedAt: v.savedAt } : g);
    });
    return this.wait(v);
  }

  async deleteGroup(appId: string, groupId: string) {
    const g = this.st.groups.find(x => x.appId === appId && x.id === groupId);
    if (!g) return;
    this.toBin({ kind: 'group', id: groupId, appId, name: g.name, createdBy: g.createdBy }, s => {
      s.groups = s.groups.filter(x => x !== g);
      return { groups: [g] };
    });
  }

  // ---- recently deleted ----
  private toBin(item: Omit<DeletedItem, 'deletedAt' | 'deletedBy'>, take: (s: State) => Omit<Binned, 'item'>) {
    const me = this.me();
    this.mutate(s => {
      const was = { apps: [...s.apps], tests: [...s.tests], groups: [...s.groups], suites: [...s.suites] };
      const taken = take(s);
      const next: Record<string, string> = {};
      for (const k of LISTS) {
        const gone = new Set<object>(taken[k] ?? []);
        const list: { id: string; appId?: string }[] = was[k];
        list.forEach((x, i) => {
          if (!gone.has(x)) return;
          const n = list.slice(i + 1).find(y => !gone.has(y));
          if (n) next[placeKey(k, x)] = placeKey(k, n);
        });
      }
      s.bin.push({ item: { ...item, deletedAt: Date.now(), deletedBy: me }, ...taken, next });
    });
  }
  private binned(r: DeletedRef) {
    const b = this.st.bin.find(x => sameRef(x.item, r));
    if (!b) throw new Error('This is no longer in Recently deleted.');
    return b;
  }
  /** Deletes the item's versions and, for an app, everything of it, including what was deleted in it before. */
  private purge(s: State, b: Binned) {
    const { kind, id, appId } = b.item;
    if (kind === 'app') {
      for (const k of Object.keys(s.versions)) if (k.startsWith(`${id}/`)) delete s.versions[k];
      for (const k of Object.keys(s.groupVersions)) if (k.startsWith(`${id}/`)) delete s.groupVersions[k];
      s.runs = s.runs.filter(r => r.appId !== id);
      s.bin = s.bin.filter(x => x.item.appId !== id);
    }
    if (kind === 'test') delete s.versions[`${appId}/${id}`];
    if (kind === 'group') delete s.groupVersions[`${appId}/${id}`];
    if (kind === 'suite') this.addresses.delete(id);
    s.bin = s.bin.filter(x => x !== b);
  }
  readonly recentlyDeleted: RecentlyDeleted = {
    items: (l, appId) => this.watch(() => {
      const live = new Map(this.st.apps.map(a => [a.id, a.name]));
      return this.st.bin.map(b => b.item)
        .filter(i => (appId ? i.appId === appId && live.has(appId) : !i.appId || live.has(i.appId)))
        .map(i => (i.appId ? { ...i, appName: live.get(i.appId) } : i))
        .sort(newestDeletedFirst);
    }, l),
    restore: async r => {
      const b = this.binned(r);
      if (b.item.appId && !this.st.apps.some(a => a.id === b.item.appId)) throw new Error('Its app was deleted. Restore the app first.');
      this.mutate(s => {
        s.bin = s.bin.filter(x => x !== b);
        // Back in its place: before what came after it, if that's still there.
        const put = <T extends { id: string; appId?: string }>(k: typeof LISTS[number], list: T[], back: T[] = []) => {
          for (const x of back) {
            const n = b.next?.[placeKey(k, x)];
            const at = n ? list.findIndex(y => placeKey(k, y) === n) : -1;
            if (at >= 0) list.splice(at, 0, x); else list.push(x);
          }
        };
        put('apps', s.apps, b.apps); put('tests', s.tests, b.tests); put('groups', s.groups, b.groups); put('suites', s.suites, b.suites);
      });
      await this.wait(null);
    },
    deleteNow: async r => {
      const b = this.binned(r);
      this.mutate(s => this.purge(s, b));
      await this.wait(null);
    },
  };

  // ---- runs ----
  runs(appId: string, l: Listener<Run[]>, limit?: Limit) { return this.watch(() => upTo(this.st.runs.filter(r => r.appId === appId).sort((a, b) => b.startedAt - a.startedAt), limit), l); }
  testRuns(appId: string, testId: string, l: Listener<Run[]>, limit?: Limit) { return this.watch(() => upTo(this.st.runs.filter(r => r.appId === appId && r.testId === testId).sort((a, b) => b.startedAt - a.startedAt), limit), l); }
  async run(appId: string, runId: string) { return this.wait(this.st.runs.find(r => r.appId === appId && r.id === runId) ?? null); }
  async addRun(r: Omit<Run, 'id'>) {
    const run: Run = { ...r, id: newId('run') };
    this.mutate(s => {
      s.runs.unshift(run);
      const by = 'name' in r.startedBy ? r.startedBy.name : r.startedBy.serviceAccount;
      s.tests = s.tests.map(t => t.appId === r.appId && t.id === r.testId ? { ...t, lastRun: { result: r.result === 'fail' ? 'fail' : r.healedCount ? 'healed' : 'pass', at: r.startedAt, by } } : t);
    });
    return this.wait(run);
  }
  /** Explanations and issues are kept on the sample runs themselves (in memory). */
  readonly runNotes: RunNotes = {
    saveExplanation: async (appId, runId, stepId, e: Explanation) => {
      this.mutate(s => {
        s.runs = s.runs.map(r => r.appId === appId && r.id === runId
          ? { ...r, steps: r.steps.map(sr => sr.stepId === stepId && sr.result === 'failed' ? { ...sr, explanation: e } : sr) } : r);
      });
    },
    setIssue: async (appId, runId, issue: RunIssue) => {
      this.mutate(s => { s.runs = s.runs.map(r => (r.appId === appId && r.id === runId ? { ...r, issue } : r)); });
    },
  };

  // ---- suites and runner ----
  suites(l: Listener<Suite[]>) { return this.watch(() => [...this.st.suites], l); }
  async saveSuite(id: string | null, n: NewSuite) {
    const me = this.me(); const now = Date.now();
    // The address of a result message is kept apart from the suite, as in a workspace.
    const { notify, ...rest } = n;
    const pub = notify ? { kind: notify.kind, when: notify.when, ...(notify.screenshot ? { screenshot: true } : {}) } : undefined;
    let out: Suite;
    if (id) {
      const before = this.st.suites.find(x => x.id === id)!;
      out = { ...before, ...rest, updatedBy: me, updatedAt: now };
      if (notify === null) delete out.notify; else if (pub) out.notify = pub;
      this.mutate(s => { s.suites = s.suites.map(x => x.id === id ? out : x); });
    } else {
      out = { id: slug(n.name) + '-' + Math.random().toString(16).slice(2, 6), ...rest, ...(pub ? { notify: pub } : {}), createdBy: me, createdAt: now, updatedBy: me, updatedAt: now };
      this.mutate(s => { s.suites.push(out); });
    }
    if (notify === null) this.addresses.delete(out.id);
    else if (notify?.url) this.addresses.set(out.id, notify.url);
    return this.wait(out);
  }
  private addresses = new Map<string, string>();
  /** Result messages: the addresses in memory, and a test message is never really posted (the sample workspace). */
  readonly notify: NotifyStore = {
    address: async suiteId => this.addresses.get(suiteId) ?? this.st.suites.find(x => x.id === suiteId)?.resultUrl ?? null,
    post: () => new Promise(res => setTimeout(() => res({ ok: true, status: 200 }), 700)),
  };
  /** Issue trackers: the sample workspace's settings, in memory (tokens are the shell's, on a Mac). */
  private trackerSettings: TrackerSettings = { github: { repo: 'acme/web', labels: ['bug'] } };
  private trackerListeners = new Set<Listener<TrackerSettings>>();
  readonly trackers: TrackerStore = {
    settings: l => { this.trackerListeners.add(l); l(this.trackerSettings); return () => { this.trackerListeners.delete(l); }; },
    save: async t => { this.trackerSettings = t; this.trackerListeners.forEach(l => l(t)); },
  };
  async deleteSuite(id: string) {
    const suite = this.st.suites.find(x => x.id === id);
    if (!suite) return;
    this.toBin({ kind: 'suite', id, name: suite.name, createdBy: suite.createdBy }, s => {
      s.suites = s.suites.filter(x => x !== suite);
      return { suites: [suite] };
    });
  }
  runner(l: Listener<RunnerStatus | null>) {
    return this.watch(() => applyRunnerPreview(this.st.runner && { ...this.st.runner, lastSeen: this.st.runner.status === 'paused' ? this.st.runner.lastSeen : Date.now() }, this.runnerPreview()), l);
  }
  /** The address's ?runner= preview (preview.ts), for screenshots of the runner's states. */
  runnerPreview(): RunnerPreview | null { return runnerPreviewFlag(); }
  queue(l: Listener<QueueItem[]>) { return this.watch(() => [...this.st.queue], l); }
  suiteRuns(l: Listener<SuiteRun[]>, limit?: Limit) { return this.watch(() => upTo([...this.st.suiteRuns], limit), l); }
  async requestSuiteRun(suiteId: string, note?: string) {
    const suite = this.st.suites.find(x => x.id === suiteId);
    if (!suite) throw new Error('Suite not found');
    const me = this.me();
    // Newest request for a suite wins: drop waiting ones for the same suite, recorded as Replaced.
    this.mutate(s => {
      const now = Date.now(), total = suite.tests.length;
      for (const q of s.queue.filter(x => x.suiteId === suiteId)) {
        s.suiteRuns.unshift({ id: newId('sr'), suiteId, suiteName: suite.name, result: 'replaced', counts: { total, passed: 0, fixed: 0, failed: 0, notRun: total }, testRunIds: [], requestedBy: q.requestedBy, replacedBy: me.name, startedAt: q.queuedAt, finishedAt: now });
      }
      s.queue = s.queue.filter(q => q.suiteId !== suiteId);
      s.queue.push({ id: newId('q'), suiteId, suiteName: suite.name, requestedBy: me.name, source: 'button', queuedAt: now, note });
    });
    await this.wait(null);
  }
  async removeFromQueue(id: string) { this.mutate(s => { s.queue = s.queue.filter(q => q.id !== id); }); }

  // ---- runner side ----
  runRequests(l: Listener<RunRequest[]>) { return this.watch(() => [...this.st.runRequests], l); }
  async claimRunRequest(requestId: string, item: Omit<QueueItem, 'id'>) {
    const q: QueueItem = { ...item, id: newId('q') };
    this.mutate(s => { s.runRequests = s.runRequests.filter(r => r.id !== requestId); s.queue.push(q); });
    return this.wait(q);
  }
  async addToQueue(item: Omit<QueueItem, 'id'>) {
    const q: QueueItem = { ...item, id: newId('q') };
    this.mutate(s => { s.queue.push(q); });
    return this.wait(q);
  }
  async heartbeat(status: RunnerStatus) { this.mutate(s => { s.runner = status; }); }
  async addSuiteRun(r: Omit<SuiteRun, 'id'>) {
    const sr: SuiteRun = { ...r, id: newId('sr') };
    this.mutate(s => {
      s.suiteRuns.unshift(sr);
      s.suites = s.suites.map(x => x.id === r.suiteId ? { ...x, lastRun: { result: r.result, at: r.startedAt, by: r.requestedBy } } : x);
    });
    return this.wait(sr);
  }
  /** Demo/tests: what an outside tool (CI, a script) would add to runRequests. */
  addRunRequest(r: Omit<RunRequest, 'id' | 'createdAt'>) { this.mutate(s => { s.runRequests.push({ ...r, id: newId('rq'), createdAt: Date.now() }); }); }

  // ---- members ----
  members(l: Listener<Member[]>) { return this.watch(() => [...this.st.members], l); }
  async setRole(uid: string, role: Role) {
    if (uid === this.st.user?.uid) throw new Error("You can't change your own role.");
    this.mutate(s => { s.members = s.members.map(m => m.uid === uid ? { ...m, role } : m); });
  }
  async removeMember(uid: string) { this.mutate(s => { s.members = s.members.filter(m => m.uid !== uid); }); }

  // ---- demo-only helpers ----
  setRunnerStatus(r: RunnerStatus | null) { this.mutate(s => { s.runner = r; }); }
}

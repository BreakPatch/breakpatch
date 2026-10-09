// The one interface the UI talks to. Implemented by the demo backend (in memory,
// seeded like the prototype), the local backend (Community: JSON files in a folder on this
// Mac, data/local/) and, in the Team edition, the Firebase backend (the workspace's named
// Firestore database). Reads are live subscriptions; writes return promises.

import type {
  App, Explanation, FlakyMark, HttpCall, Member, Millis, NotifyInput, Person, QueueItem, RecordedOn, Role, Run, RunnerStatus, RunRequest, Step, StepGroup,
  RunIssue, Suite, SuiteRun, Test, TestStatus, TrackerSettings, Version, Viewport, Workspace,
} from './types';

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

export interface NewApp { name: string; baseUrl: string; defaultViewport: Viewport; icon?: string }
export interface NewTest {
  appId: string; name: string; description?: string; startUrl: string; viewport: Viewport;
  setUp?: HttpCall; cleanUp?: HttpCall & { alsoOnFailure?: boolean };
}
/** A test's details as the Test details dialog edits them. */
export interface TestDetails { name: string; description?: string; startUrl: string }
export interface NewSuite {
  name: string; tests: Suite['tests']; schedule: Suite['schedule']; resultUrl?: string;
  /** Where the result goes (Team, admins). With `url`, the address is saved apart from the suite; without, it stays as it was. */
  notify?: NotifyInput | null;
  /** How often a failed test is tried again (lib/retries.ts). Left out: as it was. */
  retries?: number;
}

/** The note on the version a new start address makes (Backend.updateTestDetails). */
export const startUrlNote = (url: string) => `Start address changed to ${url}`;

/** Details with their optional parts left out when empty, trimmed. */
export function cleanDetails(d: TestDetails): TestDetails {
  const description = d.description?.trim();
  return { name: d.name.trim(), ...(description ? { description } : {}), startUrl: d.startUrl.trim() };
}

/**
 * What cleaned details (cleanDetails) change on a test as it's stored now: its name, its
 * description (none and "" are the same) and its start address (`moved`: a new version then
 * starts there). `changed`: any of them. For each backend's updateTestDetails.
 */
export function detailsDiff(current: { name?: unknown; description?: unknown; startUrl?: unknown }, d: TestDetails): { name: boolean; description: boolean; moved: boolean; changed: boolean } {
  const name = d.name !== current.name;
  const description = d.description !== (typeof current.description === 'string' && current.description ? current.description : undefined);
  const moved = d.startUrl !== current.startUrl;
  return { name, description, moved, changed: name || description || moved };
}

/**
 * Where a run of this version starts: the version's own start address, else the test's.
 * Versions saved before versions had one, and every version of the local backend, have none.
 */
export function startUrlOf(test: Pick<Test, 'startUrl'>, version?: Pick<Version, 'startUrl'> | null): string {
  return version?.startUrl || test.startUrl;
}

/**
 * Lists that grow for ever (runs, versions, suite runs) take an optional `limit`: at most that
 * many, newest first, so a screen asks only for what it shows and asks again with a larger one
 * for more (data/hooks.ts `usePagedLive`). Without it, all of them.
 */
export type Limit = number | undefined;
/** The first `limit` of a newest-first list (all of it without one). */
export function upTo<T>(list: T[], limit: Limit): T[] { return limit === undefined ? list : list.slice(0, Math.max(0, limit)); }

export class AuthError extends Error {
  /**
   * `signInOff`: the workspace's Firebase project doesn't have email and password sign-in turned on.
   * `unverified`: the address isn't confirmed yet; the message says which email to open.
   * `setup`: the workspace isn't set up right (its database or rules); the message says what to fix.
   */
  code: 'wrongPassword' | 'wrongDomain' | 'network' | 'signInOff' | 'unverified' | 'setup' | 'unknown';
  /** `setup`: which part of the workspace's set-up to fix, when the backend knows (the screen links to it). */
  fix?: 'database' | 'rules';
  constructor(code: AuthError['code'], message: string, fix?: AuthError['fix']) { super(message); this.code = code; if (fix) this.fix = fix; }
}

// ---------- What only some backends can do ----------
// Each is an optional part of Backend: a backend that can sets it, and callers use
// `backend.<part>?.…` and nothing else (never duck typing, never `kind`).

/**
 * What's added to a saved run later, apart from the run (it's written once and only ever read
 * after): the AI assistant's explanation of a failed step (#7) and the issue made from it (#5).
 * The run lists and `run()` show them merged into the run.
 */
export interface RunNotes {
  /** Keeps "Why did this fail?" for the run's failed step, so it isn't asked again. A refused write is only a cache miss. */
  saveExplanation(appId: string, runId: string, stepId: string, e: Explanation): Promise<void>;
  /** Notes the issue made from a run (Create issue), so the report offers Open issue to everyone. */
  setIssue(appId: string, runId: string, issue: RunIssue): Promise<void>;
}

/** A suite's result messages (Team): the secret address, and how a message is posted. */
export interface NotifyStore {
  /** The suite's result address, which only admins and the runner may read. null when there's none or this account can't read it. */
  address(suiteId: string): Promise<string | null>;
  /**
   * How to post a message, when not through the shell: the sample workspace answers without
   * sending anything anywhere. Unset: the shell posts it.
   */
  post?: (url: string, body: string) => Promise<{ ok: boolean; status: number; body?: string }>;
}

/**
 * Recently deleted: deleting an app, a test, shared steps or a suite moves it here for
 * KEEP_DELETED_DAYS, with everything in it, and it can be put back. After that (or on Delete now)
 * it's deleted for good. Who may restore or delete it for good is who may delete it
 * (canManageDeleted).
 */
export interface RecentlyDeleted {
  /**
   * What's in it, newest first: deleted apps and suites, and the deleted tests and shared steps of
   * apps that aren't deleted themselves (a deleted app keeps its own, and they come back with it).
   * With `appId`: only that app's tests and shared steps.
   */
  items(l: Listener<DeletedItem[]>, appId?: string): Unsubscribe;
  /** Puts it back where it was. */
  restore(r: DeletedRef): Promise<void>;
  /** Deletes it for good now, with everything in it (an app's tests, versions and runs; a test's versions). */
  deleteNow(r: DeletedRef): Promise<void>;
}

export type DeletedKind = 'app' | 'test' | 'group' | 'suite';
/** Which item in Recently deleted. `appId`: a test's or shared steps' app. */
export interface DeletedRef { kind: DeletedKind; id: string; appId?: string }
export interface DeletedItem extends DeletedRef {
  name: string;
  /** A test's or shared steps' app. */
  appName?: string;
  deletedAt: Millis;
  deletedBy: Person;
  /** Who made it, and a test's status: a member may restore their own draft test (canManageDeleted). */
  createdBy: Person;
  status?: TestStatus;
}

/** How long deleted things stay in Recently deleted. */
export const KEEP_DELETED_DAYS = 30;
export const KEEP_DELETED_MS = KEEP_DELETED_DAYS * 86_400_000;
/** When an item deleted at `deletedAt` is deleted for good. */
export const purgeAtOf = (deletedAt: Millis) => deletedAt + KEEP_DELETED_MS;
/** Days left in Recently deleted, counting the one it's in (30 just after it's deleted; 0 once it's due to go). */
export function daysLeft(deletedAt: Millis, now = Date.now()): number {
  return Math.max(0, Math.ceil((purgeAtOf(deletedAt) - now) / 86_400_000));
}
/**
 * Who may restore an item or delete it for good: whoever may delete it. Admins anything; members
 * their own draft tests (as the workspace rules say).
 */
export function canManageDeleted(item: Pick<DeletedItem, 'kind' | 'createdBy' | 'status'>, role: Role, uid: string | undefined): boolean {
  if (role === 'admin') return true;
  return role === 'member' && item.kind === 'test' && item.status !== 'published' && !!uid && item.createdBy.uid === uid;
}
export const newestDeletedFirst = (a: DeletedItem, b: DeletedItem) => b.deletedAt - a.deletedAt;

/** Where Create issue sends issues (Team): the workspace's tracker settings. */
export interface TrackerStore {
  settings(l: Listener<TrackerSettings>): Unsubscribe;
  /** Admins only. */
  save(t: TrackerSettings): Promise<void>;
}

export interface Backend {
  readonly kind: 'demo' | 'firebase' | 'local';
  /** Optional: things added to saved runs later (see RunNotes). */
  readonly runNotes?: RunNotes;
  /** Optional (Team): result messages (see NotifyStore). */
  readonly notify?: NotifyStore;
  /** Optional (Team): issue trackers (see TrackerStore). */
  readonly trackers?: TrackerStore;
  /** Recently deleted (see RecentlyDeleted): where deleteApp, deleteTest, deleteGroup and deleteSuite move things. */
  readonly recentlyDeleted?: RecentlyDeleted;
  /** The team workspace; null for a local tests folder. */
  readonly workspace: Workspace | null;
  /** The tests folder (kind 'local'). */
  readonly local?: { path: string };
  /** Optional: plain lines about data that was skipped (e.g. a file that isn't valid JSON). Calls `l` at once. */
  onWarnings?(l: Listener<string[]>): Unsubscribe;
  /** Optional: stop watching for changes when the app switches away from this backend. */
  close?(): void;
  /**
   * Optional: true while this backend can't save (e.g. the workspace holds data from a newer
   * app). Writes then throw a plain error; the app shows a banner. Calls `l` at once.
   */
  onReadOnly?(l: Listener<boolean>): Unsubscribe;

  // Auth
  currentUser(): Person | null;
  onUser(l: Listener<Person | null>): Unsubscribe;
  signIn(email: string, password: string): Promise<Person>;
  sendPasswordReset(email: string): Promise<void>;
  signOut(): Promise<void>;
  myRole(): Role;

  // Apps
  apps(l: Listener<App[]>): Unsubscribe;
  addApp(a: NewApp): Promise<App>;
  updateApp(id: string, patch: Partial<NewApp>): Promise<void>;
  /** Admins. To Recently deleted, with its tests, shared steps and runs. */
  deleteApp(id: string): Promise<void>;

  // Tests and versions
  tests(appId: string, l: Listener<Test[]>): Unsubscribe;
  test(appId: string, testId: string, l: Listener<Test | null>): Unsubscribe;
  createTest(t: NewTest): Promise<Test>;
  versions(appId: string, testId: string, l: Listener<Version[]>, limit?: Limit): Unsubscribe;
  version(appId: string, testId: string, n: number): Promise<Version | null>;
  /**
   * Writes a new immutable version and bumps currentVersion. `recordedOn`: where its steps were
   * recorded, when this save has steps recorded or re-recorded; without it the version keeps the
   * one before's.
   */
  saveTest(appId: string, testId: string, steps: Step[], note?: string, recordedOn?: RecordedOn): Promise<Version>;
  setTestStatus(appId: string, testId: string, status: TestStatus): Promise<void>;
  renameTest(appId: string, testId: string, name: string): Promise<void>;
  /**
   * Changes a test's name, description and start address. The start address is part of what a
   * version replays, so a new one on a test with saved steps is saved as a new version (the same
   * steps, with `startUrl` on the version and a note saying so). Name and description aren't
   * versioned. Returns the new version when one was made. Nothing changed: writes nothing.
   */
  updateTestDetails(appId: string, testId: string, d: TestDetails): Promise<Version | null>;
  /** Marks a saved version as the one CI runs with `--version released` (null clears it). Team workspaces only. */
  setReleasedVersion?(appId: string, testId: string, version: number | null): Promise<void>;
  /**
   * Someone's answer to the test's Flaky marker (lib/flaky.ts): known flaky, not flaky, or null to
   * take it back. It isn't an edit of the test: no new version, and its Last updated stays.
   */
  setFlakyMark?(appId: string, testId: string, mark: FlakyMark | null): Promise<void>;
  duplicateTest(appId: string, testId: string): Promise<Test>;
  /** To Recently deleted, with its versions (its runs stay in the app's runs). */
  deleteTest(appId: string, testId: string): Promise<void>;

  // Shared steps
  stepGroups(appId: string, l: Listener<StepGroup[]>): Unsubscribe;
  groupVersions(appId: string, groupId: string, l: Listener<Version[]>, limit?: Limit): Unsubscribe;
  groupVersion(appId: string, groupId: string, n: number): Promise<Version | null>;
  createGroup(appId: string, name: string, description: string, steps: Step[]): Promise<StepGroup>;
  saveGroup(appId: string, groupId: string, steps: Step[], note?: string): Promise<Version>;
  /** Admins. To Recently deleted, with its versions. The screens offer it only while no test uses them. */
  deleteGroup(appId: string, groupId: string): Promise<void>;

  // Runs
  runs(appId: string, l: Listener<Run[]>, limit?: Limit): Unsubscribe;
  testRuns(appId: string, testId: string, l: Listener<Run[]>, limit?: Limit): Unsubscribe;
  run(appId: string, runId: string): Promise<Run | null>;
  /**
   * `o.trigger`: what started a runner run, for the usage counts only (data/countUsage.ts); it's
   * never saved and backends may ignore it.
   */
  addRun(r: Omit<Run, 'id'>, o?: { trigger?: 'schedule' }): Promise<Run>;

  // Suites and local runner
  suites(l: Listener<Suite[]>): Unsubscribe;
  saveSuite(id: string | null, s: NewSuite): Promise<Suite>;
  /** Admins. To Recently deleted, with its schedule and where its result goes (its suite runs stay). */
  deleteSuite(id: string): Promise<void>;
  runner(l: Listener<RunnerStatus | null>): Unsubscribe;
  queue(l: Listener<QueueItem[]>): Unsubscribe;
  suiteRuns(l: Listener<SuiteRun[]>, limit?: Limit): Unsubscribe;
  /** Creates a runRequests document; the runner picks it up. */
  requestSuiteRun(suiteId: string, note?: string): Promise<void>;
  removeFromQueue(id: string): Promise<void>;

  // Runner side (used by the RunnerService on the runner Mac, spec §12.4)
  /** Live list of runRequests/{auto}, oldest first. */
  runRequests(l: Listener<RunRequest[]>): Unsubscribe;
  /** Deletes the request and adds the item to runnerQueue in one write (batch/transaction). */
  claimRunRequest(requestId: string, item: Omit<QueueItem, 'id'>): Promise<QueueItem>;
  /** Adds to runnerQueue directly (schedules). */
  addToQueue(item: Omit<QueueItem, 'id'>): Promise<QueueItem>;
  /** Writes runner/current. */
  heartbeat(status: RunnerStatus): Promise<void>;
  /** Writes suiteRuns/{id} and the suite's lastRun. */
  addSuiteRun(r: Omit<SuiteRun, 'id'>): Promise<SuiteRun>;

  // Members
  members(l: Listener<Member[]>): Unsubscribe;
  setRole(uid: string, role: Role): Promise<void>;
  removeMember(uid: string): Promise<void>;
}

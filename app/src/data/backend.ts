// The one interface the UI talks to. Implemented by the demo backend (in memory,
// seeded like the prototype), the local backend (Community: JSON files in a folder on this
// Mac, data/local/) and, in the Team edition, the Firebase backend (the workspace's named
// Firestore database). Reads are live subscriptions; writes return promises.

import type {
  App, HttpCall, Member, Person, QueueItem, RecordedOn, Role, Run, RunnerStatus, RunRequest, Step, StepGroup,
  Suite, SuiteRun, Test, TestStatus, Version, Viewport, Workspace,
} from './types';

export type Unsubscribe = () => void;
export type Listener<T> = (value: T) => void;

export interface NewApp { name: string; baseUrl: string; defaultViewport: Viewport; icon?: string }
export interface NewTest {
  appId: string; name: string; description?: string; startUrl: string; viewport: Viewport;
  setUp?: HttpCall; cleanUp?: HttpCall & { alsoOnFailure?: boolean };
}
export interface NewSuite { name: string; tests: Suite['tests']; schedule: Suite['schedule']; resultUrl?: string }

export class AuthError extends Error {
  code: 'wrongPassword' | 'wrongDomain' | 'network' | 'unknown';
  constructor(code: AuthError['code'], message: string) { super(message); this.code = code; }
}

export interface Backend {
  readonly kind: 'demo' | 'firebase' | 'local';
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
  deleteApp(id: string): Promise<void>;

  // Tests and versions
  tests(appId: string, l: Listener<Test[]>): Unsubscribe;
  test(appId: string, testId: string, l: Listener<Test | null>): Unsubscribe;
  createTest(t: NewTest): Promise<Test>;
  versions(appId: string, testId: string, l: Listener<Version[]>): Unsubscribe;
  version(appId: string, testId: string, n: number): Promise<Version | null>;
  /**
   * Writes a new immutable version and bumps currentVersion. `recordedOn`: where its steps were
   * recorded, when this save has steps recorded or re-recorded; without it the version keeps the
   * one before's.
   */
  saveTest(appId: string, testId: string, steps: Step[], note?: string, recordedOn?: RecordedOn): Promise<Version>;
  setTestStatus(appId: string, testId: string, status: TestStatus): Promise<void>;
  renameTest(appId: string, testId: string, name: string): Promise<void>;
  /** Marks a saved version as the one CI runs with `--version released` (null clears it). Team workspaces only. */
  setReleasedVersion?(appId: string, testId: string, version: number | null): Promise<void>;
  duplicateTest(appId: string, testId: string): Promise<Test>;
  deleteTest(appId: string, testId: string): Promise<void>;

  // Shared steps
  stepGroups(appId: string, l: Listener<StepGroup[]>): Unsubscribe;
  groupVersions(appId: string, groupId: string, l: Listener<Version[]>): Unsubscribe;
  groupVersion(appId: string, groupId: string, n: number): Promise<Version | null>;
  createGroup(appId: string, name: string, description: string, steps: Step[]): Promise<StepGroup>;
  saveGroup(appId: string, groupId: string, steps: Step[], note?: string): Promise<Version>;

  // Runs
  runs(appId: string, l: Listener<Run[]>): Unsubscribe;
  testRuns(appId: string, testId: string, l: Listener<Run[]>): Unsubscribe;
  run(appId: string, runId: string): Promise<Run | null>;
  /**
   * `o.trigger`: what started a runner run, for the usage counts only (data/countUsage.ts); it's
   * never saved and backends may ignore it.
   */
  addRun(r: Omit<Run, 'id'>, o?: { trigger?: 'schedule' }): Promise<Run>;

  // Suites and local runner
  suites(l: Listener<Suite[]>): Unsubscribe;
  saveSuite(id: string | null, s: NewSuite): Promise<Suite>;
  deleteSuite(id: string): Promise<void>;
  runner(l: Listener<RunnerStatus | null>): Unsubscribe;
  queue(l: Listener<QueueItem[]>): Unsubscribe;
  suiteRuns(l: Listener<SuiteRun[]>): Unsubscribe;
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

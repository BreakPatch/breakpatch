// Data model shared by the UI, the demo backend and the Firebase backend.
// Mirrors specs/spec.md §12 (Firestore) and §12.4 (local runner).

export type Millis = number;

export interface Person { uid: string; name: string; email: string }

export interface Viewport { width: number; height: number; dpr: 1 }

export type Role = 'member' | 'admin' | 'runner' | 'ci';

export interface Workspace {
  name: string;
  logo?: string;                 // data URL or https URL
  config: FirebaseWebConfig;
  database: string;              // named Firestore database, default "breakpatch"
  domain: string;                // allowed email domain, e.g. "example.com"; '' for a hosted workspace
  /**
   * Hosted by Breakpatch (Breakpatch Cloud): the workspace's tenant id. Its documents are under
   * workspaces/<tenant>/ in the shared project, and its connection id is `hosted:<tenant>`.
   * Unset for a workspace in the team's own Firebase.
   */
  tenant?: string;
  /**
   * Legacy, a starting value only: how many days runs are kept, as a saved hosted connection
   * remembered it. The Team backend reads the real number from the person's member document (the
   * cloud keeps it there) and uses this only until that's read; nothing else decides by it (not
   * whether a workspace is hosted: that's `tenant`). Unset for a team's own Firebase (90 days).
   */
  historyDays?: number;
}

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  measurementId?: string;
}

export interface Member extends Person { role: Role; lastActive?: Millis }

// ---------- Apps, tests, steps ----------

export interface App {
  id: string;
  name: string;
  baseUrl: string;
  icon?: string;                 // Material Symbols name
  defaultViewport: Viewport;
  createdBy: Person; createdAt: Millis;
}

export type TestStatus = 'draft' | 'published';   // UI: "Only you" / "In team suite"

/** A header on a set-up or clean-up call: a fixed value, or a saved secret's (by name). */
export interface CallHeader { name: string; value?: string; secretRef?: string }

/**
 * A set-up or clean-up call (engine/PROTOCOL.md "Set-up and clean-up calls"): https to the app's
 * own hosts unless `allowOtherHosts` ("Allow other hosts"), no redirects, no private addresses.
 */
export interface HttpCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: CallHeader[];
  allowOtherHosts?: boolean;
}

export interface Test {
  id: string;
  appId: string;
  name: string;
  description?: string;
  startUrl: string;
  status: TestStatus;
  viewport: Viewport;            // locked at creation
  currentVersion: number;
  /** The version pipelines run with `breakpatch-ci --version released` (Team: Version history → Mark as released). */
  releasedVersion?: number;
  setUp?: HttpCall;
  cleanUp?: HttpCall & { alsoOnFailure?: boolean };
  stepCount: number;
  lastRun?: RunSummary;
  createdBy: Person; createdAt: Millis;
  updatedBy: Person; updatedAt: Millis;
}

export type Box = [number, number, number, number];   // x1, y1, x2, y2 in viewport px at DPR 1
export type Point = [number, number];

export interface RegionCheck { region: Box; hash: string; tolerance: number; expectChange?: boolean }

export type ActionKind =
  | 'click' | 'doubleClick' | 'longClick' | 'rightClick' | 'hover'
  | 'swipe' | 'scroll' | 'drag'
  | 'write'
  | 'waitUntil' | 'waitFor'
  | 'navigate' | 'switchTab' | 'upload' | 'downloadCheck'
  | 'checkpoint'
  | 'loop' | 'group';

export type Direction = 'up' | 'down' | 'left' | 'right';
export type SampleFile = 'docx' | 'pdf' | 'jpeg' | 'mp4' | 'xlsx' | 'csv';
export type Generated = 'uniqueName' | 'timeNow' | 'today' | 'repeatNumber';

export interface Step {
  id: string;
  action: ActionKind;
  label: string;                 // "Click Done"
  target?: string;               // "What to look for"
  at?: Point;
  pre?: RegionCheck;
  post?: RegionCheck;
  ignore?: Box[];
  // action-specific
  from?: Point; to?: Point; direction?: Direction; distance?: number;
  text?: string; secretRef?: string; generated?: Generated;
  region?: Box; hash?: string; tolerance?: number; timeoutMs?: number;
  durationMs?: number;
  url?: string; nav?: 'url' | 'reload' | 'back' | 'forward';
  sample?: SampleFile;
  /** A Write into a field that hides what's typed (a password): shown as dots, the field's inside left out of checks. */
  masked?: boolean;
  /** "What should happen": how replay judges the step (absent: as before it existed). */
  expect?: Expect;
  /** A plain note on what should happen, read by the AI assistant only when the check fails. */
  expectNote?: string;
  /** An upload of one of the user's own files: "files/<name>", in the tests folder. */
  file?: string;
  fileType?: string; minBytes?: number;
  count?: number;                // loop
  groupId?: string; groupVersion?: number | 'latest';
  steps?: Step[];                // loop children; group children resolved before a run
  // UI-only markers (not persisted by the engine)
  rerecorded?: boolean;
}

/**
 * Where a test's steps were recorded (engine/PROTOCOL.md "Where a test was recorded"). Screen
 * checks are compared with how the page looked on that system: another OS family or Chromium
 * major draws text a little differently. Tests recorded before this existed have none.
 */
export interface RecordedOn { os: string; osVersion?: string; arch?: string; chromium?: string }

export interface Version {
  number: number;
  steps: Step[];
  savedBy: Person; savedAt: Millis;
  note?: string;
  /** Set when steps were recorded or re-recorded for this version; kept from the one before otherwise. */
  recordedOn?: RecordedOn;
  /**
   * Tests only: the start address this version starts at. Versions saved before it existed have
   * none, and the local backend never sets it (it keeps only the latest version): they start at
   * the test's. Read it with startUrlOf (backend.ts).
   */
  startUrl?: string;
}

export interface StepGroup {
  id: string;
  appId: string;
  name: string;
  description?: string;
  currentVersion: number;
  stepCount: number;
  usedBy: { testId: string; version: number | 'latest' }[];
  createdBy: Person; createdAt: Millis;
  updatedBy: Person; updatedAt: Millis;
}

// ---------- Runs ----------

export type StepResult = 'passed' | 'healed' | 'failed' | 'notRun';
export type Expect = 'newPage' | 'closes' | 'appears' | 'changes' | 'noChange';

export type FailReason =
  | 'targetNotFound' | 'unexpectedScreen' | 'noChange' | 'timeout'
  | 'healFailed' | 'healingUnavailable' | 'secretMissing' | 'setUpFailed' | 'stopped' | 'fileMissing';

export type RunSource = 'desktop' | 'ci' | 'runner';

export interface StepRun {
  stepId: string;
  result: StepResult;
  reason?: FailReason;
  preDistance?: number; postDistance?: number;
  oldAt?: Point; newAt?: Point;
  screenshotPath?: string;       // local only
  /** Passed another way than matching the recording: "gone" (what it closed is gone), "note" (the AI read the step's note). */
  passedBy?: 'gone' | 'note';
  /** With passedBy "note": the AI assistant's sentence. */
  why?: string;
  /** Where the step's time went (engine run.step `timings`). */
  timings?: StepTimings;
  /** Checks that had nothing left to compare (their ignore zones cover them), so they were skipped. */
  unchecked?: string[];
  /** A failed step: the AI assistant's "Why did this fail?" (Team, engine run.explain), once asked. */
  explanation?: Explanation;
}

/**
 * Why a step failed, in plain words, from the AI assistant (engine/PROTOCOL.md "Why did this
 * fail?"). Always shown as the AI assistant's. Unknown `cause` or `suggestion` values (a newer
 * engine) are shown without their words.
 */
export interface Explanation {
  /** One or two plain sentences: "The Save button now reads “Save changes”." */
  summary: string;
  cause: 'moved' | 'textChanged' | 'pageChanged' | 'slowLoad' | 'errorPage' | 'realBug';
  suggestion: 'rerecord' | 'acceptChange' | 'raiseWait' | 'reportBug';
}

/** A step's phases in a run, in ms: the check before it, the action, waiting for the page to settle, the check after. */
export interface StepTimings { preMs?: number; actionMs?: number; settleMs?: number; postMs?: number; settled?: boolean; preTries?: number; postTries?: number }

/** A run on another kind of system than the test was recorded on (engine run.ended `systemMismatch`). */
export interface SystemMismatch {
  recordedOn: RecordedOn;
  ranOn: RecordedOn;
  differences: ('os' | 'chromium')[];
  /** "Allow for small differences between systems" was on, so screen checks were more tolerant. */
  relaxed: boolean;
  /** The plain explanation the report shows when a check failed. */
  message: string;
}

export interface Run {
  id: string;
  appId: string;
  testId: string;
  testName: string;
  testVersion: number;
  startedBy: Person | { serviceAccount: string };
  machine: string;
  source: RunSource;
  startedAt: Millis;
  durationMs: number;
  result: 'pass' | 'fail';
  healedCount: number;
  steps: StepRun[];
  systemMismatch?: SystemMismatch;
  /** The issue made from this run with Create issue (Team), so the report offers Open issue next time. */
  issue?: RunIssue;
  /**
   * A plain note about how the run came about, shown in the report and the run history: a missed
   * schedule run late (Solo on a tests folder), "This 8:00 run was missed, so it ran when Breakpatch
   * opened at 9:14."
   */
  note?: string;
}

export type IssueProvider = 'github' | 'linear' | 'jira';
/** An issue in a tracker made from a failed run: its provider, key ("acme/web#12", "ENG-42") and web address. */
export interface RunIssue { provider: IssueProvider; key: string; url: string }

export interface RunSummary { result: 'pass' | 'fail' | 'healed'; at: Millis; by: string }

// ---------- Suites and local runner ----------

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface Suite {
  id: string;                    // e.g. "smoke-7f3a"
  name: string;
  tests: { appId: string; testId: string }[];
  schedule: null | { days: Weekday[]; time: string };
  /** Before `notify`: a plain JSON result address on the suite itself. Read as `notify` kind "webhook", every run. */
  resultUrl?: string;
  /** Where the runner sends the result (Team). The address itself is kept apart (see SuiteNotify). */
  notify?: SuiteNotify;
  lastRun?: { result: SuiteResult; at: Millis; by: string };
  createdBy: Person; createdAt: Millis;
  updatedBy: Person; updatedAt: Millis;
}

export type SuiteResult = 'passed' | 'passed_with_fixes' | 'failed' | 'replaced';

/** A result message's format: plain JSON (any tool), a Slack incoming webhook, a Teams Workflows webhook. */
export type NotifyKind = 'webhook' | 'slack' | 'teams';
/** Every run, failed runs only, or the first failure and the first pass after it. */
export type NotifyWhen = 'every' | 'failures' | 'changes';

/**
 * Where a suite's result goes, as the suite keeps it and everyone reads it. Never the address: that
 * is a secret (anyone with it can post), which a workspace keeps where only admins and the runner
 * can read it (Backend.notify).
 */
export interface SuiteNotify {
  kind: NotifyKind;
  when: NotifyWhen;
  /** Put the failed step's screenshot in the message (uploaded so Slack or Teams can show it). Off by default. */
  screenshot?: boolean;
}

/**
 * What an admin's save sends: the public part, and `url` when a new address was pasted (it's saved
 * apart from the suite). Only the save path takes this type; the suite never holds it.
 */
export type NotifyInput = SuiteNotify & { url?: string | null };

/** Where Create issue sends issues (Team, workspace/trackers): set by admins, used by everyone with their own token. */
export interface TrackerSettings {
  github?: { repo: string; labels?: string[] };
  linear?: { team: string };
  jira?: { site: string; project: string; issueType?: string; labels?: string[] };
}

export interface RunnerStatus {
  name: string;
  status: 'waiting' | 'running' | 'paused';
  current?: { suiteId: string; suiteName: string; test: string; index: number; total: number; startedBy: string; startedAt: Millis; passed: number; failed: number };
  lastSeen: Millis;
  /** Set by the runner when a result message could not be sent after 3 tries (spec §20). */
  warning?: string;
  appVersion: string;
  memoryGb: number;
  model: string;
}

export interface QueueItem {
  id: string;
  suiteId: string;
  suiteName: string;
  requestedBy: string;
  source: 'schedule' | 'button' | 'request';
  queuedAt: Millis;
  note?: string;
}

/** runRequests/{auto}: added by the Run button, schedules, CI or any tool; the runner queues it and deletes it. */
export interface RunRequest {
  id: string;
  suiteId: string;
  requestedBy?: string;
  note?: string;
  createdAt: Millis;
}

export interface SuiteRun {
  id: string;
  suiteId: string;
  suiteName: string;
  result: SuiteResult;
  counts: { total: number; passed: number; fixed: number; failed: number; notRun: number };
  testRunIds: string[];
  requestedBy: string;
  replacedBy?: string;
  startedAt: Millis;
  finishedAt: Millis;
}

// ---------- Local-only ----------

/** A saved secret in Settings: never its value. `origins` are the sites it may be typed on. */
export interface SecretInfo { name: string; usedBy: number; present: boolean; origins: string[]; runnerCanUse: boolean }

/** What the shell keeps next to each saved secret's name (app/src-tauri/src/secrets.rs). */
export interface SecretPolicy { name: string; origins: string[]; runnerCanUse: boolean }

// The extension point between the open Community app and the paid Team edition
// (docs/editions.md). The Team module lives in the private BreakPatch/breakpatch-team
// repo and is linked in at app/src/edition/team (scripts/link-team.sh); without it the
// app builds as Community. Team code imports open code as `@bp/…`; open code never
// imports Team code, only this contract.
import type { ComponentType, LazyExoticComponent, ReactNode } from 'react';
import type { Backend } from '../data/backend';
import type { ActionKind, NotifyInput, Person, Run, Step, StepRun, Suite, Test, Workspace } from '../data/types';
import type { MenuItem } from '../components/ui';
import type { Connection } from '../state/connections';
import type { SealedSecret } from '../engine/engine';

/**
 * What the edition allows. Community has all of these off. They can change while the app runs
 * (Team: from the licence), so read them through features.ts: `useFeature` / `hasFeature`.
 */
export interface Features {
  /** Shared workspace, members, "Only you / In team suite". */
  collaboration: boolean;
  /** Version history and restore; with it off, saving overwrites. */
  versions: boolean;
  /** Fixed automatically, Accept new position, Fail the test if anything needed fixing. */
  autoFix: boolean;
  calibration: boolean;
  schedules: boolean;
  /** Local runner, run requests, result messages. */
  runner: boolean;
  /** Headless command line for CI. */
  ci: boolean;
  modelOverride: boolean;
  /** "Why did this fail?": the AI assistant explains a failed step in the report (engine run.explain). */
  explain: boolean;
  /** Create issue in GitHub, Linear or Jira from a failed run. */
  integrations: boolean;
  /** "Write a test from a story": the AI assistant proposes the steps of a user story in the recorder (engine record.plan). */
  aiTests: boolean;
  /** "Wait for an email" steps and the workspace's test inbox (engine `emailWait`, issue #12). */
  email: boolean;
}

export const NO_FEATURES: Features = {
  collaboration: false, versions: false, autoFix: false, calibration: false,
  schedules: false, runner: false, ci: false, modelOverride: false, explain: false, integrations: false, aiTests: false,
  email: false,
};

type Screen = ComponentType | LazyExoticComponent<ComponentType>;

export interface EditionRoute { path: string; element: Screen }

export interface SettingsSection {
  key: string;
  icon: string;
  label: string;
  /** Where it goes in the sidebar: sections are sorted by this (Community's are 10, 40, 60, 80, 85, 90). */
  order: number;
  element: Screen;
  /** Sub-pages that highlight this section, e.g. "runner-requests" under "runner". */
  subPages?: Record<string, Screen>;
  /** Shown only while this feature is on, e.g. "runner" for Local runner. */
  feature?: keyof Features;
  /** A hook (called on every render of Settings): false hides the section, e.g. while no tests folder is open. */
  useVisible?: () => boolean;
}

export interface NavItem {
  value: string; label: string; path: string; order: number;
  /** A hook (called on every render of the title bar) for the dot after the label, e.g. the runner's state. */
  useDot?: (enabled: boolean) => string | undefined;
  /** Shown only while this feature is on. */
  feature?: keyof Features;
}

/** What the first-launch gate looks at. */
export interface GateState {
  workspace: Workspace | null;
  /** The tests folder on this Mac, when one is open instead of a workspace. */
  local: { path: string } | null;
  user: Person | null;
  pendingWorkspace: Workspace | null;
}

/** Suite editor fields that only an edition's panel edits (schedule, result address). */
export interface SuiteExtras {
  schedule: Suite['schedule']; resultUrl?: string;
  /** Where the result goes; `url` only when the panel changed the address. null: nowhere. */
  notify?: NotifyInput | null;
}

export interface SuiteEditorPanelProps {
  /** The saved suite, or undefined while it's new or loading. */
  suite: Suite | undefined;
  suiteId: string | null;
  name: string;
  testCount: number;
  /** Save was pressed: show every problem. */
  tried: boolean;
  value: SuiteExtras;
  /** Every edit, with the first problem that blocks saving (or undefined). */
  onChange(v: SuiteExtras, problem?: string): void;
}

export interface ReportFixProps {
  run: Run;
  /** The fixed step's result, with `oldAt` and `newAt`. */
  stepRun: StepRun;
  /** The step as it ran (shared steps resolved), when it's still known. */
  step: Step | undefined;
  /** The test now (its current version may be newer than the one the run tested). */
  test: Test | undefined;
}

export interface ReportFailProps extends ReportFixProps {
  /** Steps as the run tested them (shared steps resolved). */
  steps: Step[];
  /** "6", or "2.3" inside a shared-steps card. */
  number: string;
  appName: string;
}

/** Places in open screens where the Team edition adds its own pieces. */
export interface Slots {
  /** Suites list: extra columns after Name, before (default) or after "Last run", e.g. Schedule and "Result goes to". */
  suiteColumns?: { header: string; width: string; afterLastRun?: boolean; Cell: ComponentType<{ suite: Suite }> }[];
  /** Suites list: action per suite row, e.g. "Run on runner". */
  suiteRowAction?: ComponentType<{ suite: Suite }>;
  /** Suites list: a hook naming the suite running right now and its progress (tints the row). */
  useRunningSuite?: () => { suiteId: string; index: number; total: number } | undefined;
  /** Suites list: the note next to the heading, e.g. "Runs on the local runner". */
  suitesNote?: string;
  /** Suite editor side panel: schedule, result address, "Start it from anywhere". */
  suiteEditorPanel?: ComponentType<SuiteEditorPanelProps>;
  /** Suite editor title bar: e.g. "Run on runner". `prepare` saves first and gives the saved suite. */
  suiteEditorAction?: ComponentType<{ suite: Suite | undefined; prepare: () => Promise<Suite | null>; disabled: boolean }>;
  /** First launch: extra choice under "Start on this Mac", e.g. "Connect a workspace". */
  welcomeExtra?: ComponentType;
  /** Home, above the apps (and above the first-use card): e.g. "Upgrade to Team" while a tests folder is open. Renders nothing when it has nothing to say. */
  homeBanner?: ComponentType;
  /** Report, a step fixed automatically: e.g. "Accept new position" and Dismiss. */
  reportFixActions?: ComponentType<ReportFixProps>;
  /** Report, a failed step: e.g. Create issue (GitHub, Linear, Jira) or Open issue. */
  reportFailActions?: ComponentType<ReportFailProps>;
  /** Under the title bar, after the system banners, e.g. "Breakpatch Team needs a licence." */
  banner?: ComponentType;
  /** Settings → Saved secrets, under this Mac's own: e.g. the workspace's secrets (Team, issue #45). */
  secretsPanel?: ComponentType;
  /**
   * The workspace switcher (title bar): a hook giving why switching is off right now, in plain
   * words, or null (Team: on the local runner's Mac, which serves one workspace).
   */
  useSwitchLock?: () => string | null;
  /**
   * The workspace switcher: extra entries at the end, e.g. "Add a workspace". Called while
   * rendering, with what the switcher shows (so it re-renders with it), its router's navigate, and
   * whether switching is locked now (useSwitchLock).
   */
  switcherActions?: (o: { close(): void; navigate(path: string): void; workspace: Workspace | null; connections: readonly Connection[]; locked: boolean }) => MenuItemEntry[];
  /**
   * The workspace switcher: rendered beside its menu (in the title bar, inside the router), for what
   * its actions open, e.g. a sheet or a folder picker's question.
   */
  switcherExtra?: ComponentType;
  /** The workspace switcher: ⌘1 to ⌘9 open its first nine entries, and its menu shows them (Team). */
  switcherShortcuts?: boolean;
  /** The recorder's action list: actions the edition performs (Team: Wait for an email). */
  recorderActions?: RecorderAction[];
}

/**
 * What a recorder action's dialog gets (Slots.recorderActions): `step` when it edits one, else it
 * adds one. `onSave` adds the step (the recorder has the engine do it, as for any step: it isn't
 * added when that doesn't work, and the recorder says why) or saves the edit. It resolves false
 * when the step wasn't added: the dialog then stays open; otherwise the dialog closes itself.
 */
export interface RecorderActionDialogProps {
  open: boolean;
  step?: Step;
  /** The steps of the test so far (what the step can use, e.g. `{email}`). */
  steps: Step[];
  onSave(patch: Partial<Step>): void | boolean | Promise<boolean | void>;
  onClose(): void;
}

/**
 * An action the edition adds to the recorder's action list, with its own dialog for adding and
 * editing the step (Team: Wait for an email, issue #12). Shown only while `feature` is on; a test
 * that has such a step still lists and runs it without (the run fails it with `actionUnavailable`).
 */
export interface RecorderAction {
  kind: ActionKind;
  /** The menu's name ("Wait for an email") and icon. */
  name: string;
  icon: string;
  /** The action list's group it goes in, after the open ones ("Email"). */
  group: string;
  feature?: keyof Features;
  Dialog: ComponentType<RecorderActionDialogProps>;
}

/** A workspace secret as the screens may know it: its name and who may use it, never its value. */
export interface WorkspaceSecretName { name: string; runnerCanUse: boolean }

/**
 * Saved secrets an admin keeps in the open workspace for everyone (Breakpatch Team, issue #45).
 * Sealed in the workspace with its key, and opened only by the shell, for the engine
 * (app/src-tauri/src/workspace_secrets.rs): the screens get names, and requests carry the sealed
 * values (lib/secretScope.ts). A secret on this Mac of the same name wins.
 */
export interface WorkspaceSecrets {
  /** The open workspace's secrets this person (or the runner) may use. [] when there are none, or none can be read. */
  names(backend: Backend): Promise<WorkspaceSecretName[]>;
  /** The sealed values of those of `names` the workspace has, for one request. */
  sealed(backend: Backend, names: string[]): Promise<SealedSecret[]>;
}

/** An entry the edition adds to a menu: the ui Menu's own item. */
export type MenuItemEntry = MenuItem;

export interface Edition {
  name: 'community' | 'team';
  /** The features at start (Community: all off, locked). Team's Provider sets them from the licence. */
  features: Features;
  /** Extra routes, e.g. /runner, /apps/:appId/tests/:testId/history. */
  routes: EditionRoute[];
  settings: SettingsSection[];
  /** Extra top-nav items after "Apps" and "Suites". */
  nav: NavItem[];
  slots: Slots;
  /**
   * First-launch gate before Setup: the path to show, or null when the person may go on.
   * `pathname` is the screen showing now, so the check can let it stay when it may show instead of
   * the one it would ask for (Team: Welcome, to start on this Mac from the connect screen).
   * `paths` are the screens only the gate shows (left for the app once it says null).
   */
  gate: { check(s: GateState, pathname: string): string | null; paths: string[] };
  /** Where the app opens after the gate, e.g. runner mode on the runner Mac. Default "/". */
  startPath?(): string;
  /**
   * Where a tests folder's suite result addresses are kept, apart from the folder (the Team
   * edition's Solo plan: the Keychain). Community has none, so its folder backend keeps none.
   */
  resultAddresses?: import('../data/local/localBackend').AddressStore;
  /** The open workspace's own saved secrets (Team). Community has none: secrets are this Mac's only. */
  workspaceSecrets?: WorkspaceSecrets;
  /** Opens a connected workspace. Community has none: it opens the demo and local tests folders. */
  openWorkspace?(ws: Workspace): Promise<Backend>;
  /** Wraps the app, e.g. for licence checks and workspace links. */
  Provider?: ComponentType<{ children: ReactNode }>;
}

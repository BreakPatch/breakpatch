// UI-side view of the Python engine (see engine/PROTOCOL.md).
import type { Box, Explanation, HttpCall, Point, RecordedOn, SampleFile, Step, StepRun, SystemMismatch, Viewport } from '../data/types';

export interface SystemInfo {
  memoryGb: number; chip: string; os: string; engineVersion: string;
  /** "team" when the engine has the Breakpatch Team engine (healing) built in. */
  edition: 'community' | 'team';
  browser: { installed: boolean; version?: string };
  model: { installed: boolean; repo?: string; revision?: string; sizeBytes?: number; path?: string };
  /** This system, as a recording saves it in `recordedOn`. Missing from an older engine. */
  system?: RecordedOn;
}

export type SetupTaskName = 'browser' | 'model';
export interface SetupProgress {
  task: SetupTaskName; state: 'busy' | 'paused' | 'done' | 'failed';
  doneBytes?: number; totalBytes?: number; etaSeconds?: number; message?: string;
}

export interface Frame { jpeg: string; width: number; height: number; seq: number }

export type CheckingPhase = 'watching' | 'acting' | 'settling' | 'reloading' | 'naming' | 'choosing';

/** A click opened the page's file picker: the app asks which file to use (`record.chooseFile`). */
/** `stepId`: the picker opened a moment after that (already recorded) click: answering it makes the step an upload. */
export interface FileChooserEvent { accept: string; multiple: boolean; stepId?: string }
export type HandInput =
  | { kind: 'down' | 'up' | 'move' | 'click'; at: Point; button?: 'left' | 'right' | 'middle' }
  | { kind: 'wheel'; at: Point; dx: number; dy: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string };
export type FileChoice = { sample: SampleFile } | { file: string; path: string } | { cancel: true };

export type RecordParams = Partial<Omit<Step, 'id' | 'label' | 'target' | 'pre' | 'post' | 'ignore'>> & {
  action: Step['action']; at?: Point;
  /** A "Write saved secret" step's value, by name. Typed, never stored in the step; the shell adds its sites. */
  secrets?: Record<string, string>;
  /**
   * The `seq` of the live view frame the user clicked or drew on. The engine acts only while the
   * page still looks like it there, else fails with `stale` and does nothing. Never stored in the step.
   */
  frame?: number;
  /** What to look for, when the user already said it (a step found with the AI assistant). */
  target?: string;
  /** The step's name, when the app already has one (the engine then doesn't ask the AI assistant). */
  label?: string;
  /** <tests folder>/files, for uploads of the user's own files. */
  filesDir?: string;
};

/** What a click on the live view would act on (nothing is done to the page): `record.propose`. */
export interface Proposal { at: Point; frame?: number; box?: Box; name?: string; target?: string }

/** `frame`: the live view frame the box was found on (pass it on when recording the step). */
// `path`: how the engine found it (engine/PROTOCOL.md): from the page's own controls ("fast"), by
// the AI assistant after those weren't enough ("fast-visual"), or by the AI assistant alone
// ("visual"). `s0Score`: the page-structure score, whenever it was used. The UI doesn't show them.
export type LocatePath = 'fast' | 'fast-visual' | 'visual';
/** record.locate `near`: the stepper's "+" (increase) or "−" (decrease) next to `of` ("People"). */
export interface Near { control: 'increase' | 'decrease'; of: string }

/** record.intent: the AI assistant's reading of a described step, when the app's own can't decide. */
export interface EngineIntent { action: string; repeat: number; target?: string; text?: string; direction?: string; seconds?: number }

export interface LocateResult { box: Box; at: Point; target: string; frame?: number; path?: LocatePath; s0Score?: number }

export interface RunSettings {
  autoFix: boolean; failOnFix: boolean;
  /** "Allow for small differences between systems": the engine treats a missing value as on. */
  allowSystemDifferences?: boolean;
}
export interface RunStart {
  runId: string; startUrl: string; viewport: Viewport; steps: Step[];
  /** The app's base address: set-up and clean-up calls may only go to its hosts. Defaults to `startUrl`. */
  appUrl?: string;
  setUp?: HttpCall; cleanUp?: HttpCall & { alsoOnFailure?: boolean };
  /**
   * Saved secret values by name. The shell adds each one's sites and "Runner can use" flag from
   * the Keychain index before the engine sees them (engine/PROTOCOL.md "Saved secrets").
   */
  settings: RunSettings; secrets: Record<string, string>;
  /** Set by Breakpatch Team's local runner: secrets without "Runner can use" are then refused. */
  runner?: boolean;
  /** The recorder's Run and Play to here: the browser stays open at the end, and no clean-up call. */
  keepOpen?: boolean;
  /** Play to here: stop after this step passes. */
  upToStepId?: string;
  /** Play this step: start at this step on the page as it is (with keepOpen). */
  fromStepId?: string;
  /** <tests folder>/files, where uploads of the user's own files come from. */
  filesDir?: string;
  /** Where the test was recorded (its version's `recordedOn`), to compare with this system. */
  recordedOn?: RecordedOn;
}

/** The answer to "Try it" for a set-up or clean-up call (engine `call.try`). */
export interface CallReply {
  ok: boolean; status?: number; ms?: number;
  error?: 'invalid' | 'refused' | 'redirect' | 'secret' | 'unreachable' | 'timeout' | 'status';
  /** A plain sentence when it didn't work. */
  message?: string;
}
export interface RunStepEvent {
  runId: string; index: number; stepId: string;
  state: 'running' | 'looking' | 'passed' | 'healed' | 'failed';
  reason?: StepRun['reason']; oldAt?: Point; newAt?: Point; screenshot?: string;
  passedBy?: StepRun['passedBy']; why?: string; timings?: StepRun['timings']; unchecked?: string[];
}
export interface RunEnded {
  runId: string; result: 'pass' | 'fail'; durationMs: number; steps: StepRun[];
  /** This system, once the browser opened. */
  ranOn?: RecordedOn;
  /** The test was recorded on another kind of system. */
  systemMismatch?: SystemMismatch;
}

export interface EngineEvents {
  'frame': Frame;
  'setup.progress': SetupProgress;
  'record.checking': { phase: CheckingPhase };
  'record.fileChooser': FileChooserEvent;
  /** A recorded step changed after it was answered (a late file picker made a click an upload). */
  'record.stepChanged': { step: Step };
  /** A file picker the page opened while the user uses it by hand (answer with handChooseFile). */
  'browser.fileChooser': FileChooserEvent;
  'run.step': RunStepEvent;
  'run.ended': RunEnded;
}

export class EngineError extends Error {
  code: string; details?: string;
  constructor(code: string, message: string, details?: string) { super(message); this.code = code; this.details = details; }
}

export interface Engine {
  /** 'frames': live view is a stream of screenshots. 'sample': demo, the live view renders the built-in sample app. */
  readonly liveMode: 'frames' | 'sample';
  on<K extends keyof EngineEvents>(event: K, cb: (data: EngineEvents[K]) => void): () => void;

  systemInfo(): Promise<SystemInfo>;
  installBrowser(): Promise<{ version: string }>;
  downloadModel(repo: string, revision: string): Promise<{ path: string; sizeBytes: number }>;
  pauseSetup(task: SetupTaskName): Promise<void>;
  removeModel(): Promise<void>;

  openBrowser(url: string, viewport: Viewport): Promise<void>;
  closeBrowser(): Promise<void>;
  navigate(nav: 'url' | 'reload' | 'back' | 'forward', url?: string): Promise<void>;
  pointer(kind: 'move' | 'scroll', at: Point, dx?: number, dy?: number): Promise<void>;

  recordPoint(p: RecordParams): Promise<Step>;
  /** `near`: the "+" or "−" next to something ("add 2 people"), found from the page's structure first. */
  locate(description: string, opts?: { near?: Near }): Promise<LocateResult | null>;
  /** What a described step means, from the AI assistant; null without it or when it can't tell. */
  intent(sentence: string): Promise<EngineIntent | null>;
  /** The element at a point and its name, without acting. `name: false` skips the AI assistant. */
  propose(at: Point, opts?: { name?: boolean }): Promise<Proposal>;
  /** The answer to a `record.fileChooser` event. */
  chooseFile(choice: FileChoice): Promise<void>;
  /** "Use the page": the user's own input goes straight to the page; nothing is recorded. */
  hand(on: boolean): Promise<void>;
  /** One piece of input while it's on. Key values are never logged. */
  input(i: HandInput): Promise<void>;
  handChooseFile(choice: FileChoice): Promise<void>;
  recordCheckpoint(region: Box, frame?: number): Promise<Step>;

  startRun(r: RunStart): Promise<void>;
  stopRun(runId: string): Promise<void>;

  /** "Try it": one request under the same rules as a run's set-up and clean-up calls. */
  tryCall(call: HttpCall, appUrl: string, secrets?: Record<string, string>): Promise<CallReply>;

  /**
   * "Why did this fail?" for one failed step of a finished run (Team; engine `run.explain`).
   * null when the AI assistant couldn't tell. Throws EngineError `not_ready` in Community, without
   * the licence feature or without the AI assistant; `not_found` when the screenshot isn't on this Mac.
   */
  explain(step: Step, stepRun: StepRun, viewport: Pick<Viewport, 'width' | 'height'>): Promise<Explanation | null>;
}

/**
 * Model repositories (spec §7). The engine only downloads what its own table allows
 * (engine/src/breakpatch_engine/models.py, with a SHA-256 per file); these must match it (a test
 * checks). TODO(owner): the organisation repos and their commit SHAs, as in models.py.
 */
export const MODELS = {
  standard: { repo: 'OscarShaitan/Qwen3-VL-4B-Instruct-4bit', revision: '4e992f95b3b3ae22b4f25201b1b9d960448a5a1a', label: 'Standard', approxBytes: 3.0e9 },
  larger: { repo: 'OscarShaitan/Qwen3-VL-8B-Instruct-4bit', revision: '5a5a1651d020507af5d6a4c5443a82b3775952e0', label: 'Larger', approxBytes: 5.0e9 },
} as const;

/** Setup always installs the Standard (4B) assistant. The Larger (8B) one is only downloaded
 *  when someone asks for it: it needs 32 GB and gives no big accuracy gain. */
export function modelFor(_memoryGb: number) { return MODELS.standard; }
export function canUseLarger(memoryGb: number) { return memoryGb >= 32; }
export function modelLabel(repo: string | undefined) { return repo === MODELS.larger.repo ? MODELS.larger.label : MODELS.standard.label; }

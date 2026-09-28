// UI-side view of the Python engine (see engine/PROTOCOL.md).
import type { Box, HttpCall, Point, Step, StepRun, Viewport } from '../data/types';

export interface SystemInfo {
  memoryGb: number; chip: string; os: string; engineVersion: string;
  /** "team" when the engine has the Breakpatch Team engine (healing) built in. */
  edition: 'community' | 'team';
  browser: { installed: boolean; version?: string };
  model: { installed: boolean; repo?: string; revision?: string; sizeBytes?: number; path?: string };
}

export type SetupTaskName = 'browser' | 'model';
export interface SetupProgress {
  task: SetupTaskName; state: 'busy' | 'paused' | 'done' | 'failed';
  doneBytes?: number; totalBytes?: number; etaSeconds?: number; message?: string;
}

export interface Frame { jpeg: string; width: number; height: number; seq: number }

export type CheckingPhase = 'watching' | 'acting' | 'settling' | 'reloading' | 'naming';

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
};

/** `frame`: the live view frame the box was found on (pass it on when recording the step). */
export interface LocateResult { box: Box; at: Point; target: string; frame?: number }

export interface RunSettings { autoFix: boolean; failOnFix: boolean }
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
}
export interface RunEnded { runId: string; result: 'pass' | 'fail'; durationMs: number; steps: StepRun[] }

export interface EngineEvents {
  'frame': Frame;
  'setup.progress': SetupProgress;
  'record.checking': { phase: CheckingPhase };
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
  locate(description: string): Promise<LocateResult | null>;
  recordCheckpoint(region: Box, frame?: number): Promise<Step>;

  startRun(r: RunStart): Promise<void>;
  stopRun(runId: string): Promise<void>;

  /** "Try it": one request under the same rules as a run's set-up and clean-up calls. */
  tryCall(call: HttpCall, appUrl: string, secrets?: Record<string, string>): Promise<CallReply>;
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

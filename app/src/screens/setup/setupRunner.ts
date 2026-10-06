// Drives first-launch setup through the engine: test browser, this Mac's memory, AI assistant.
// Kept apart from the screen so the order, skipping, pause/resume and retry are testable.
// The AI assistant follows the engine's `runtime` (system.info), nothing else: MLX models on Apple
// Silicon; where it's llama.cpp, the row is skipped with a plain note until the llama.cpp runtime
// has a setup row of its own (plan P2.6). A skipped row never counts as downloaded, but setup can
// finish without it.
import { isInstalled, modelFor, modelsFor, type Engine, type ModelChoice, type SetupProgress, type SetupTaskName, type SystemInfo } from '../../engine/engine';
import type { TaskState } from '../../state/session';

export type RowKey = 'browser' | 'mac' | 'model';
export const ROWS: RowKey[] = ['browser', 'mac', 'model'];

export interface Row {
  state: TaskState;
  doneBytes?: number; totalBytes?: number; etaSeconds?: number;
  /** Plain reason when paused or failed. */
  reason?: string;
  /** Technical details for "Copy details". */
  details?: string;
}
export interface SetupSnapshot {
  rows: Record<RowKey, Row>;
  info: SystemInfo | null;
  model: ModelChoice | null;
  /** Size of the AI assistant on disk once downloaded (or the expected size before). */
  modelBytes: number | null;
}

const OFFLINE = 'Lost connection to the internet.';
/** The model row's note where the engine runs the AI assistant with llama.cpp. */
export const NOT_YET = "The AI assistant for this computer comes in a later update. Everything else works without it.";

/** Whether a row needs nothing more: done, or skipped (not for this computer yet). */
export const complete = (s: TaskState) => s === 'done' || s === 'skipped';

export class SetupRunner {
  private snap: SetupSnapshot = { rows: { browser: { state: 'waiting' }, mac: { state: 'waiting' }, model: { state: 'waiting' } }, info: null, model: null, modelBytes: null };
  private listeners = new Set<(s: SetupSnapshot) => void>();
  private gen = 0;
  private off: () => void;
  private engine: Engine;
  private macCheckMs: number;

  constructor(engine: Engine, macCheckMs = 700) {
    this.engine = engine; this.macCheckMs = macCheckMs;
    this.off = engine.on('setup.progress', p => this.onProgress(p));
  }

  get state() { return this.snap; }
  subscribe(l: (s: SetupSnapshot) => void) { this.listeners.add(l); return () => { this.listeners.delete(l); }; }
  dispose() { this.gen++; this.off(); this.listeners.clear(); }

  get done() { return ROWS.every(k => complete(this.snap.rows[k].state)); }

  /** Starts or resumes from the first task that isn't done. Downloads continue where they stopped. */
  start() { void this.run(); }
  retry() { void this.run(); }

  /** Pauses whatever is downloading, e.g. when the Mac goes offline. */
  async pause(reason = OFFLINE) {
    for (const task of ['browser', 'model'] as SetupTaskName[]) {
      if (this.snap.rows[task].state !== 'busy') continue;
      this.gen++;                              // the running start call is now stale
      this.setRow(task, { state: 'paused', reason });
      await this.engine.pauseSetup(task).catch(() => {});
    }
  }

  private set(p: Partial<SetupSnapshot>) { this.snap = { ...this.snap, ...p }; this.listeners.forEach(l => l(this.snap)); }
  private setRow(k: RowKey, r: Partial<Row>, replace = false) {
    const row: Row = replace ? { state: 'waiting', ...r } : { ...this.snap.rows[k], ...r };
    if (row.state !== 'paused' && row.state !== 'failed' && row.state !== 'skipped') { row.reason = undefined; row.details = undefined; }
    this.set({ rows: { ...this.snap.rows, [k]: row } });
  }

  private onProgress(p: SetupProgress) {
    if (p.task !== 'browser' && p.task !== 'model') return;   // the llama.cpp runtime has no row yet (plan P2.6)
    const row = this.snap.rows[p.task];
    if (complete(row.state)) return;
    if (row.state === 'paused' && p.state === 'busy') return;   // a late tick from before the pause
    const bytes = { doneBytes: p.doneBytes ?? row.doneBytes, totalBytes: p.totalBytes ?? row.totalBytes, etaSeconds: p.etaSeconds };
    if (p.state === 'paused') this.setRow(p.task, { ...bytes, state: 'paused', reason: p.message ?? row.reason ?? OFFLINE });
    else if (p.state === 'failed') this.setRow(p.task, { ...bytes, state: 'failed', reason: p.message ?? "It didn't work." });
    else this.setRow(p.task, { ...bytes, state: p.state });
  }

  private async run() {
    const gen = ++this.gen;
    const stale = () => gen !== this.gen;
    let task: RowKey = 'mac';
    try {
      const info = this.snap.info ?? await this.engine.systemInfo();
      if (stale()) return;
      if (!this.snap.info) this.set({ info });

      task = 'browser';
      if (this.snap.rows.browser.state !== 'done') {
        if (info.browser.installed) this.setRow('browser', { state: 'done' });
        else {
          this.setRow('browser', { state: 'busy', etaSeconds: undefined });
          await this.engine.installBrowser();
          if (stale()) return;
          this.setRow('browser', { state: 'done' });
        }
      }

      task = 'mac';
      if (this.snap.rows.mac.state !== 'done') {
        this.setRow('mac', { state: 'busy' });
        await new Promise(r => setTimeout(r, this.macCheckMs));   // long enough to see it happen
        if (stale()) return;
        // Keep a larger assistant someone chose on purpose; otherwise install the standard one, of
        // the models this machine's runtime loads.
        const larger = modelsFor(info.runtime).larger;
        const model = larger && info.model.installed && info.model.repo === larger.repo ? larger : modelFor(info.memoryGb, info.runtime);
        const sameRepo = info.model.repo === model.repo;
        this.set({ model, modelBytes: (sameRepo && info.model.sizeBytes) || model.approxBytes });
        this.setRow('mac', { state: 'done' });
      }

      task = 'model';
      if (!complete(this.snap.rows.model.state) && info.runtime === 'llamacpp') {
        this.setRow('model', { state: 'skipped', reason: NOT_YET });
      } else if (!complete(this.snap.rows.model.state)) {
        const model = this.snap.model!;
        // The same repo at another revision (an older release's) is downloaded again: the engine
        // only loads the revision in its table.
        if (isInstalled(info.model, model)) this.setRow('model', { state: 'done' });
        else {
          this.setRow('model', { state: 'busy', totalBytes: this.snap.rows.model.totalBytes ?? this.snap.modelBytes ?? undefined });
          const r = await this.engine.downloadModel(model.repo, model.revision);
          if (stale()) return;
          this.set({ modelBytes: r.sizeBytes });
          this.setRow('model', { state: 'done', doneBytes: r.sizeBytes, totalBytes: r.sizeBytes });
        }
      }
    } catch (e) {
      if (stale() || this.snap.rows[task].state === 'paused') return;
      const err = e as { message?: string; code?: string; details?: string };
      this.setRow(task, { state: 'failed', reason: err?.message || "It didn't work.", details: [err?.code && `Code: ${err.code}`, err?.details].filter(Boolean).join('\n') || undefined });
    }
  }
}

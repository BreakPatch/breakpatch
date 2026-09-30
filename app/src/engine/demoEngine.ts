// Simulated engine for the browser preview and tests. Timings follow the prototype:
// "Checking the screen…" ~1 s, run steps ~750 ms each, AI thinking ~1.5 s.
import type { Box, Explanation, FailReason, HttpCall, Point, Step, StepRun, Viewport } from '../data/types';
import { EngineError, type CallReply, type Engine, type EngineEvents, type FileChoice, type HandInput, type LocateResult, type Near, type EngineIntent, type Proposal, type RecordParams, type RunStart, type SetupTaskName, type SystemInfo } from './engine';
import { edition } from '../edition';
import { hasFeature } from '../edition/features';
import { labelFor } from './labels';
import { MODELS_DIR } from './paths';

type Handler = (d: unknown) => void;

/** Targets the demo can "find" on the sample app. The recorder's sample page registers its hotspots here. */
export interface DemoTarget { key: string; words: string[]; box: Box; target: string; label: string; visible: () => boolean }

export class DemoEngine implements Engine {
  readonly liveMode = 'sample' as const;
  private handlers = new Map<string, Set<Handler>>();
  private timers = new Map<SetupTaskName, ReturnType<typeof setInterval>>();
  private progress: Record<SetupTaskName, number> = { browser: 0, model: 0 };
  private stops = new Set<string>();
  private nextId = 1;
  targets: DemoTarget[] = [];
  /** Step ids the demo run should fail on (the prototype fails at "Click Done" until it is re-recorded). */
  failStepIds = new Set<string>();
  // `?ready` previews a Mac that finished setup; `?mem=64` a Mac with more memory.
  private q = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  memoryGb = Number(this.q.get('mem')) || 16;
  modelInstalled = this.q.has('ready');
  browserInstalled = this.q.has('ready');
  modelRepo = 'OscarShaitan/Qwen3-VL-4B-Instruct-4bit';

  on<K extends keyof EngineEvents>(event: K, cb: (data: EngineEvents[K]) => void) {
    const set = this.handlers.get(event) ?? new Set<Handler>();
    set.add(cb as Handler); this.handlers.set(event, set);
    return () => { set.delete(cb as Handler); };
  }
  private emit<K extends keyof EngineEvents>(event: K, data: EngineEvents[K]) { this.handlers.get(event)?.forEach(h => h(data)); }
  private sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

  async systemInfo(): Promise<SystemInfo> {
    await this.sleep(300);
    return { memoryGb: this.memoryGb, chip: 'Apple M2 Pro', os: 'macOS 15.1', engineVersion: '0.1.0-demo',
      edition: edition.name, // the demo engine is whatever edition the app is
      browser: { installed: this.browserInstalled, version: this.browserInstalled ? 'Chromium 131' : undefined },
      model: { installed: this.modelInstalled, repo: this.modelRepo, revision: 'main', sizeBytes: this.modelRepo.includes('8B') ? 5.2e9 : 3.1e9 },
      system: { os: 'macOS', osVersion: '15.1', arch: 'arm64', chromium: '131.0.6778.33' } };
  }

  private download(task: SetupTaskName, total: number, secs: number): Promise<void> {
    return new Promise(resolve => {
      clearInterval(this.timers.get(task));
      const step = total / (secs * 10);
      const t = setInterval(() => {
        this.progress[task] = Math.min(total, this.progress[task] + step);
        const done = this.progress[task] >= total;
        this.emit('setup.progress', { task, state: done ? 'done' : 'busy', doneBytes: this.progress[task], totalBytes: total, etaSeconds: Math.ceil((total - this.progress[task]) / step / 10) });
        if (done) { clearInterval(t); this.timers.delete(task); resolve(); }
      }, 100);
      this.timers.set(task, t);
    });
  }
  async installBrowser() { await this.download('browser', 150e6, 2.5); this.browserInstalled = true; return { version: 'Chromium 131' }; }
  async downloadModel(repo?: string) { await this.download('model', 3.1e9, 6); this.modelInstalled = true; if (repo) this.modelRepo = repo; return { path: `${MODELS_DIR}/qwen3-vl-4b`, sizeBytes: 3.1e9 }; }
  async pauseSetup(task: SetupTaskName) {
    clearInterval(this.timers.get(task)); this.timers.delete(task);
    this.emit('setup.progress', { task, state: 'paused', doneBytes: this.progress[task], totalBytes: task === 'model' ? 3.1e9 : 150e6 });
  }
  async removeModel() { this.modelInstalled = false; this.progress.model = 0; }

  async openBrowser(_url: string, _viewport: Viewport) { await this.sleep(200); }
  async closeBrowser() {}
  async navigate() { await this.sleep(150); }
  async pointer() {}

  async recordPoint(p: RecordParams): Promise<Step> {
    for (const phase of ['watching', 'acting', 'settling'] as const) { this.emit('record.checking', { phase }); await this.sleep(phase === 'watching' ? 500 : 250); }
    const hit = p.at ? this.targets.find(t => t.visible() && inside(p.at!, t.box)) : undefined;
    const at = p.at;
    const { frame: _frame, secrets: _secrets, ...fields } = p;
    const step: Step = {
      ...fields, id: 's' + Date.now().toString(36) + (this.nextId++),
      label: hit ? hit.label.replace(/^Click/, labelFor(p.action).verb) : labelFor(p.action, p).label,
      target: hit?.target ?? (at ? 'The spot you clicked' : undefined),
      pre: at ? { region: around(at, 32), hash: fakeHash(), tolerance: 6 } : undefined,
      post: at ? { region: [Math.max(0, at[0] - 300), Math.max(0, at[1] - 200), at[0] + 300, at[1] + 200], hash: fakeHash(), tolerance: 10, expectChange: true } : undefined,
      ignore: [],
    };
    return step;
  }

  /** The demo has no AI assistant to read a sentence: the app's own reading is all there is. */
  async intent(_sentence: string): Promise<EngineIntent | null> { return null; }

  async locate(description: string, _opts: { near?: Near } = {}): Promise<LocateResult | null> {
    await this.sleep(1500);
    const low = description.toLowerCase();
    const hit = this.targets.find(t => t.visible() && t.words.some(w => low.includes(w)));
    if (!hit) return null;
    return { box: hit.box, at: [(hit.box[0] + hit.box[2]) / 2, (hit.box[1] + hit.box[3]) / 2], target: hit.target };
  }

  /** The demo's sample page has no file inputs, so this never waits. */
  async chooseFile(_choice: FileChoice) {}
  /** The demo's sample page doesn't take input by hand. */
  async hand(_on: boolean) {}
  async input(_i: HandInput) {}
  async handChooseFile(_choice: FileChoice) {}
  async propose(at: Point, opts: { name?: boolean } = {}): Promise<Proposal> {
    const hit = this.targets.find(t => t.visible() && inside(at, t.box));
    if (!hit) return { at };
    if (opts.name === false) return { at, box: hit.box };
    await this.sleep(300);
    return { at, box: hit.box, name: hit.label.replace(/^Click /, ''), target: hit.target };
  }

  /** The sample page never has the keyboard focus. */
  async focused(): Promise<{ box: Box | null; name: string | null }> { return { box: null, name: null }; }

  async recordCheckpoint(region: Box): Promise<Step> {
    this.emit('record.checking', { phase: 'watching' }); await this.sleep(700);
    return { id: 's' + Date.now().toString(36) + (this.nextId++), action: 'checkpoint', label: 'Check something is visible', target: 'Area you picked', region, hash: fakeHash(), tolerance: 8 };
  }

  async startRun(r: RunStart) {
    this.stops.delete(r.runId);
    const t0 = Date.now();
    // Pre-order walk of the nested steps (engine/PROTOCOL.md): a loop or group comes before its
    // children, which count once however often they repeat.
    const flat: Step[] = [];
    const walk = (list: Step[]) => list.forEach(s => { flat.push(s); if ((s.action === 'loop' || s.action === 'group') && s.steps) walk(s.steps); });
    walk(r.steps);
    const index = new Map(flat.map((s, i) => [s, i]));
    const results: StepRun[] = flat.map(s => ({ stepId: s.id, result: 'notRun' }));
    const emit = (s: Step, state: 'running' | 'looking' | 'passed' | 'failed', reason?: FailReason) =>
      this.emit('run.step', { runId: r.runId, index: index.get(s)!, stepId: s.id, state, ...(reason ? { reason } : {}) });
    let lastReason: FailReason = 'targetNotFound';
    const fail = (s: Step, reason: FailReason) => { lastReason = reason; results[index.get(s)!] = { stepId: s.id, result: 'failed', reason }; emit(s, 'failed', reason); return false; };
    const runList = async (list: Step[]): Promise<boolean> => { for (const s of list) if (!(await runOne(s))) return false; return true; };
    let reached = false;
    let started = !r.fromStepId;
    const holds = (s: Step): boolean => !!s.steps?.some(c => c.id === r.fromStepId || holds(c));
    const runOne = async (s: Step): Promise<boolean> => {
      if (reached) return true;
      if (!started) { if (s.id === r.fromStepId) started = true; else if (!holds(s)) return true; }
      if (this.stops.has(r.runId)) return fail(s, 'stopped');
      emit(s, 'running');
      if (s.action === 'loop' || s.action === 'group') {
        const repeats = s.action === 'loop' ? Math.max(1, s.count ?? 1) : 1;
        for (let k = 0; k < repeats; k++) if (!(await runList(s.steps ?? []))) return fail(s, lastReason);
      } else {
        await this.sleep(750);
        if (s.secretRef && !(s.secretRef in r.secrets)) return fail(s, 'secretMissing');
        if (this.failStepIds.has(s.id)) {
          if (r.settings.autoFix && s.target && s.at) { emit(s, 'looking'); await this.sleep(1200); }
          return fail(s, 'targetNotFound');
        }
      }
      results[index.get(s)!] = { stepId: s.id, result: 'passed' };
      emit(s, 'passed');
      if (r.upToStepId === s.id) reached = true;    // Play to here: the rest stays not run
      return true;
    };
    void (async () => {
      await this.sleep(300);
      const ok = await runList(r.steps);
      this.emit('run.ended', { runId: r.runId, result: ok ? 'pass' : 'fail', durationMs: Date.now() - t0, steps: results });
    })();
  }
  async stopRun(runId: string) { this.stops.add(runId); }

  /** The preview makes no request: a well-formed https address "replies" 200. */
  async tryCall(call: HttpCall, _appUrl: string): Promise<CallReply> {
    await this.sleep(400);
    if (!/^https:\/\/[^/\s]+/i.test(call.url.trim())) return { ok: false, error: 'invalid', message: 'Enter a full address, starting with https://' };
    return { ok: true, status: 200, ms: 400 };
  }

  /** The preview's "Why did this fail?": a fixed sentence per reason, as the Team engine would put it. */
  async explain(step: Step, stepRun: StepRun, _viewport: Pick<Viewport, 'width' | 'height'>): Promise<Explanation | null> {
    // The same flag as the report's button and the real engine's licence check: the feature, not the edition.
    if (!hasFeature('explain')) throw new EngineError('not_ready', 'Explaining failures is part of Breakpatch Team.');
    await this.sleep(1200);
    const name = (step.target ?? '').split(',')[0].trim().replace(/^(the|a|an)\s+/i, '');
    const the = name ? `The ${name}` : 'What this step acts on';
    switch (stepRun.reason) {
      case 'targetNotFound': case 'healFailed':
        return { summary: `${the} isn't where it was. It's now at the top right of the screen.`, cause: 'moved', suggestion: 'rerecord' };
      case 'noChange':
        return { summary: `The step used ${name ? `the ${name}` : 'the page'}, but nothing on the page changed the way it did when it was recorded.`, cause: 'realBug', suggestion: 'reportBug' };
      case 'timeout':
        return { summary: 'The page was still loading or changing when the time to wait ran out.', cause: 'slowLoad', suggestion: 'raiseWait' };
      case 'unexpectedScreen':
        return { summary: "After this step the screen didn't look the way it did when it was recorded.", cause: 'pageChanged', suggestion: 'acceptChange' };
      default: return null;
    }
  }
}

function inside(p: Point, b: Box) { return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]; }
function around(p: Point, r: number): Box { return [p[0] - r, p[1] - r, p[0] + r, p[1] + r]; }
function fakeHash() { return Array.from({ length: 16 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join(''); }

// Engine client for the real app: requests go through the Tauri shell to the Python sidecar.
import { invoke } from '@tauri-apps/api/core';
import { useSystem } from '../state/system';
import { listen } from '@tauri-apps/api/event';
import type { Box, Explanation, HttpCall, Point, Step, StepRun, Viewport } from '../data/types';
import { EngineError, type CallReply, type Engine, type EngineEvents, type FileChoice, type HandInput, type LocateResult, type Near, type EngineIntent, type Plan, type Proposal, type RecordParams, type ReportImageReply, type ReportImageRequest, type RunStart, type SetupTaskName, type SystemInfo } from './engine';

interface Wire { event: keyof EngineEvents; data: unknown }

export class SidecarEngine implements Engine {
  readonly liveMode = 'frames' as const;
  private handlers = new Map<string, Set<(d: unknown) => void>>();

  constructor() {
    void listen<Wire>('engine://event', e => { useSystem.getState().markEngineReady(); this.handlers.get(e.payload.event)?.forEach(h => h(e.payload.data)); });
    // Ask at once, so "Starting Breakpatch…" ends the moment the engine can answer.
    void this.systemInfo().catch(() => undefined);
  }

  on<K extends keyof EngineEvents>(event: K, cb: (data: EngineEvents[K]) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(cb as (d: unknown) => void); this.handlers.set(event, set);
    return () => { set.delete(cb as (d: unknown) => void); };
  }

  private async call<T>(method: string, params: object = {}): Promise<T> {
    try {
      const got = await invoke<T>('engine_request', { method, params });
      useSystem.getState().markEngineReady();
      return got;
    } catch (e) {
      const err = (typeof e === 'string' ? safeParse(e) : e) as { code?: string; message?: string; details?: string } | null;
      throw new EngineError(err?.code ?? 'internal', err?.message ?? 'Something went wrong in the engine.', err?.details ?? String(e));
    }
  }

  systemInfo() { return this.call<SystemInfo>('system.info'); }
  installBrowser() { return this.call<{ version: string }>('setup.installBrowser'); }
  downloadModel(repo: string, revision: string) { return this.call<{ path: string; sizeBytes: number }>('setup.downloadModel', { repo, revision }); }
  async pauseSetup(task: SetupTaskName) { await this.call('setup.pause', { task }); }
  async removeModel() { await this.call('setup.removeModel'); }

  async openBrowser(url: string, viewport: Viewport) { await this.call('browser.open', { url, viewport: { width: viewport.width, height: viewport.height } }); }
  async closeBrowser() { await this.call('browser.close'); }
  async navigate(nav: 'url' | 'reload' | 'back' | 'forward', url?: string) { await this.call('browser.navigate', { nav, url }); }
  async pointer(kind: 'move' | 'scroll', at: Point, dx?: number, dy?: number) { await this.call('browser.pointer', { kind, at, dx, dy }); }

  async recordPoint(p: RecordParams) { return (await this.call<{ step: Step }>('record.point', p)).step; }
  locate(description: string, opts: { near?: Near; shows?: boolean } = {}) {
    return this.call<LocateResult | null>('record.locate', { description, ...(opts.near ? { near: opts.near } : {}), ...(opts.shows ? { shows: true } : {}) });
  }
  intent(sentence: string) { return this.call<EngineIntent | null>('record.intent', { sentence }); }
  async chooseFile(choice: FileChoice) { await this.call('record.chooseFile', choice); }
  async hand(on: boolean) { await this.call('browser.hand', { on }); }
  async input(i: HandInput) { await this.call('browser.input', i); }
  async handChooseFile(choice: FileChoice) { await this.call('browser.chooseFile', choice); }
  propose(at: Point, opts: { name?: boolean } = {}) { return this.call<Proposal>('record.propose', { at, ...(opts.name === false ? { name: false } : {}) }); }
  focused() { return this.call<{ box: Box | null; name: string | null }>('record.focused'); }
  plan(story: string, secrets: string[]) { return this.call<Plan>('record.plan', { story, secrets }); }
  async recordCheckpoint(region: Box, frame?: number) { return (await this.call<{ step: Step }>('record.checkpoint', { region, frame })).step; }

  async startRun(r: RunStart) { await this.call('run.start', r); }
  async stopRun(runId: string) { await this.call('run.stop', { runId }); }

  /** Through the engine, not the webview's fetch: the release CSP blocks that, and the engine keeps to the same rules as a run. */
  tryCall(call: HttpCall, appUrl: string, secrets: Record<string, string> = {}) { return this.call<CallReply>('call.try', { call, appUrl, secrets }); }

  async explain(step: Step, stepRun: StepRun, viewport: Pick<Viewport, 'width' | 'height'>) {
    const { explanation: _cached, ...sr } = stepRun;
    return (await this.call<{ explanation: Explanation | null }>('run.explain', { step, stepRun: sr, viewport: { width: viewport.width, height: viewport.height } })).explanation ?? null;
  }

  async reportImages(items: ReportImageRequest[], viewportWidth?: number) {
    if (!items.length) return [];
    return (await this.call<{ images: (ReportImageReply | null)[] }>('report.images', { items, ...(viewportWidth ? { viewportWidth } : {}) })).images ?? [];
  }
}

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return { message: s }; } }

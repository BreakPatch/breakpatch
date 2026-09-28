// Engine client for the real app: requests go through the Tauri shell to the Python sidecar.
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Box, HttpCall, Point, Step, Viewport } from '../data/types';
import { EngineError, type CallReply, type Engine, type EngineEvents, type FileChoice, type LocateResult, type Proposal, type RecordParams, type RunStart, type SetupTaskName, type SystemInfo } from './engine';

interface Wire { event: keyof EngineEvents; data: unknown }

export class SidecarEngine implements Engine {
  readonly liveMode = 'frames' as const;
  private handlers = new Map<string, Set<(d: unknown) => void>>();

  constructor() {
    void listen<Wire>('engine://event', e => this.handlers.get(e.payload.event)?.forEach(h => h(e.payload.data)));
  }

  on<K extends keyof EngineEvents>(event: K, cb: (data: EngineEvents[K]) => void) {
    const set = this.handlers.get(event) ?? new Set();
    set.add(cb as (d: unknown) => void); this.handlers.set(event, set);
    return () => { set.delete(cb as (d: unknown) => void); };
  }

  private async call<T>(method: string, params: object = {}): Promise<T> {
    try {
      return await invoke<T>('engine_request', { method, params });
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
  locate(description: string) { return this.call<LocateResult | null>('record.locate', { description }); }
  async chooseFile(choice: FileChoice) { await this.call('record.chooseFile', choice); }
  propose(at: Point, opts: { name?: boolean } = {}) { return this.call<Proposal>('record.propose', { at, ...(opts.name === false ? { name: false } : {}) }); }
  async recordCheckpoint(region: Box, frame?: number) { return (await this.call<{ step: Step }>('record.checkpoint', { region, frame })).step; }

  async startRun(r: RunStart) { await this.call('run.start', r); }
  async stopRun(runId: string) { await this.call('run.stop', { runId }); }

  /** Through the engine, not the webview's fetch: the release CSP blocks that, and the engine keeps to the same rules as a run. */
  tryCall(call: HttpCall, appUrl: string, secrets: Record<string, string> = {}) { return this.call<CallReply>('call.try', { call, appUrl, secrets }); }
}

function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return { message: s }; } }

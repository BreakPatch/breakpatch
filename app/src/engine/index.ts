import type { Engine } from './engine';
import { DemoEngine } from './demoEngine';
import { SidecarEngine } from './sidecarEngine';
import { isTauri } from '../platform';
import { useSystem } from '../state/system';

let engine: Engine | null = null;

/** The engine for this window: the Python sidecar inside Tauri, the simulated one in a browser. */
export function getEngine(): Engine {
  if (!engine) {
    engine = isTauri() && !new URLSearchParams(location.search).has('demo') ? new SidecarEngine() : new DemoEngine();
    if (engine instanceof DemoEngine) useSystem.getState().markEngineReady();   // nothing to start
  }
  return engine;
}

/** The demo engine, when running in demo mode (sample page hotspots register with it). */
export function demoEngine(): DemoEngine | null {
  const e = getEngine();
  return e instanceof DemoEngine ? e : null;
}

export * from './engine';

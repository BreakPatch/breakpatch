// Usage counts (docs/manual.md "Privacy"): only numbers, tests created and runs, never anything
// about a test. The shell keeps and sends them (src-tauri/src/usage.rs):
// - Community: anonymous daily totals with no identifier, on unless turned off here (Settings →
//   Privacy) or with BREAKPATCH_NO_USAGE=1; nothing is sent before the one-time notice was shown.
// - Team: sent with the licence check.
// In a browser preview there is no shell: everything stays in memory and nothing is sent.
import { isTauri } from '../platform';

export type RunSource = 'manual' | 'schedule' | 'runner' | 'ci';

export interface UsageSettings {
  /** How this build reports: Team with the licence check, Community on its own. */
  edition: 'team' | 'community';
  /** Community: sharing is on. */
  enabled: boolean;
  /** BREAKPATCH_NO_USAGE is set: off, whatever the setting says. */
  turnedOffByEnv: boolean;
  /** Community: the one-time notice was shown. */
  noticeSeen: boolean;
  /** Exactly what the next report would carry. */
  pending: Record<string, unknown>;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: call } = await import('@tauri-apps/api/core');
  return call<T>(cmd, args);
}

// The browser preview's stand-in (and the tests'): counts in memory, never sent.
const memory = { enabled: true, noticeSeen: false, tests: 0, runs: 0, passed: 0, failed: 0 };
function memorySettings(): UsageSettings {
  return {
    edition: 'community', enabled: memory.enabled, turnedOffByEnv: false, noticeSeen: memory.noticeSeen,
    pending: { testsCreated: memory.tests, runs: { manual: memory.runs }, runsPassed: memory.passed, runsFailed: memory.failed },
  };
}
/** Tests only: back to a first launch. */
export function resetUsageMemory() { Object.assign(memory, { enabled: true, noticeSeen: false, tests: 0, runs: 0, passed: 0, failed: 0 }); }

function quietly(p: Promise<unknown>) {
  p.catch(e => console.warn('[usage] not counted:', e instanceof Error ? e.message : String(e)));
}

export const usage = {
  /** A test was created (new or a copy). Never waits and never fails the save. */
  testCreated(): void {
    if (isTauri()) { quietly(invoke('usage_record', { kind: 'test' })); return; }
    if (memory.enabled) memory.tests++;
  },
  /** A run was saved. */
  run(source: RunSource, result: 'pass' | 'fail'): void {
    if (isTauri()) { quietly(invoke('usage_record', { kind: 'run', source, result })); return; }
    if (!memory.enabled || source !== 'manual') return;
    memory.runs++;
    if (result === 'pass') memory.passed++; else memory.failed++;
  },
  settings(): Promise<UsageSettings> {
    return isTauri() ? invoke('usage_settings') : Promise.resolve(memorySettings());
  },
  /** Community: on or off. Off drops what's waiting to be sent. */
  setEnabled(on: boolean): Promise<UsageSettings> {
    if (isTauri()) return invoke('usage_set_enabled', { on });
    memory.enabled = on; memory.noticeSeen = true;
    if (!on) Object.assign(memory, { tests: 0, runs: 0, passed: 0, failed: 0 });
    return Promise.resolve(memorySettings());
  },
  /** Community: the one-time notice was shown. */
  noticeSeen(): Promise<UsageSettings> {
    if (isTauri()) return invoke('usage_notice_seen');
    memory.noticeSeen = true;
    return Promise.resolve(memorySettings());
  },
};

function num(v: unknown): number { return typeof v === 'number' ? v : 0; }

/** "3 tests created, 12 runs (10 passed, 2 failed)" from what the next report would carry. */
export function pendingLine(p: Record<string, unknown>): string {
  const runs = Object.values((p.runs ?? {}) as Record<string, unknown>).reduce<number>((n, v) => n + num(v), 0);
  const tests = num(p.testsCreated);
  if (!tests && !runs) return 'Nothing yet.';
  const t = `${tests} test${tests === 1 ? '' : 's'} created`;
  const r = `${runs} run${runs === 1 ? '' : 's'}`;
  return runs ? `${t}, ${r} (${num(p.runsPassed)} passed, ${num(p.runsFailed)} failed)` : `${t}, no runs`;
}

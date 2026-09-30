// The sample workspace's preview flags, for screenshots and design review: `?runner=offline`,
// `none`, `waiting` or `paused` shows the local runner in that state without touching the seed.
// Only the demo backend reads them (a real workspace ignores the address's query); screens ask
// through demoPreview(backend, …), never by checking the backend's kind.
import type { Backend } from '../backend';
import { DemoBackend } from './demoBackend';
import type { RunnerStatus } from '../types';

export type RunnerPreview = 'offline' | 'none' | 'waiting' | 'paused';
const RUNNER_PREVIEWS: RunnerPreview[] = ['offline', 'none', 'waiting', 'paused'];

/** The preview flag asked for in the address, or null. */
export function runnerPreviewFlag(search = typeof location === 'undefined' ? '' : location.search): RunnerPreview | null {
  const v = new URLSearchParams(search).get('runner') as RunnerPreview | null;
  return v && RUNNER_PREVIEWS.includes(v) ? v : null;
}

/** A backend's runner preview: only the sample workspace has one (DemoBackend.runnerPreview). */
export function demoPreview(backend: Backend | null | undefined): RunnerPreview | null {
  return backend instanceof DemoBackend ? backend.runnerPreview() : null;
}

function yesterdayAt(h: number, m: number) { const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(h, m, 0, 0); return d.getTime(); }

/** The runner status as the preview shows it. */
export function applyRunnerPreview(r: RunnerStatus | null, p: RunnerPreview | null): RunnerStatus | null {
  if (!p) return r;
  if (p === 'none') return null;
  const base = r ?? { name: 'QA Mac mini', status: 'waiting' as const, lastSeen: Date.now(), appVersion: '1.4.2', memoryGb: 64, model: 'Larger' };
  if (p === 'offline') return { ...base, status: 'waiting', current: undefined, lastSeen: yesterdayAt(23, 14) };
  if (p === 'paused') return { ...base, status: 'paused' };
  return { ...base, status: 'waiting', current: undefined };
}

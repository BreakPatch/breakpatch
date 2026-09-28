// Plain-language dates, times, durations and counts, shared by every screen.
// All functions take an optional `now` so they are testable and stable in one render.
import type { RunSummary, Test, Viewport } from '../../data/types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

function startOfDay(t: number) { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); }
/** 0 = today, 1 = yesterday, negative = in the future. Uses calendar days, not 24 h windows. */
export function daysAgo(ts: number, now = Date.now()): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
}

/** "14:52" */
export function clock(ts: number): string { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }

/** "02 Sep", or "02 Sep 2025" outside the current year. */
export function dayMonth(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const base = `${pad(d.getDate())} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** "Today, 14:52" · "Yesterday, 11:20" · "02 Sep". For runs and last-run times. */
export function formatWhen(ts: number, now = Date.now()): string {
  const n = daysAgo(ts, now);
  if (n === 0) return `Today, ${clock(ts)}`;
  if (n === 1) return `Yesterday, ${clock(ts)}`;
  return dayMonth(ts, now);
}

/** "Today" · "Yesterday" · "02 Sep". For created dates. */
export function formatDay(ts: number, now = Date.now()): string {
  const n = daysAgo(ts, now);
  if (n === 0) return 'Today';
  if (n === 1) return 'Yesterday';
  return dayMonth(ts, now);
}

/** "Today, 14:40" · "Yesterday" · "12 Sep". For last-updated columns and version lists. */
export function formatUpdated(ts: number, now = Date.now()): string {
  return daysAgo(ts, now) === 0 ? `Today, ${clock(ts)}` : formatDay(ts, now);
}

/** "Today, 14:40" · "Yesterday, 11:20" · "18 Sep, 11:02". Always with the time. */
export function formatDateTime(ts: number, now = Date.now()): string {
  const n = daysAgo(ts, now);
  if (n === 0 || n === 1) return formatWhen(ts, now);
  return `${dayMonth(ts, now)}, ${clock(ts)}`;
}

/** "Last run today, 14:52 by Maria Lopez" or "No runs yet". */
export function lastRunLine(last: { at: number; by: string } | undefined, now = Date.now()): string {
  if (!last) return 'No runs yet';
  const n = daysAgo(last.at, now);
  const when = n === 0 ? `today, ${clock(last.at)}` : n === 1 ? `yesterday, ${clock(last.at)}` : dayMonth(last.at, now);
  return `Last run ${when} by ${last.by}`;
}

/** "0:41", "1:08", "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "1 test", "12 tests". */
export function plural(n: number, one: string, many = one + 's'): string { return `${n} ${n === 1 ? one : many}`; }

/** "https://app.example.com/projects" → "app.example.com". Falls back to the input. */
export function hostOf(url: string): string {
  try { return new URL(url).host || url; } catch { return url.replace(/^[a-z]+:\/\//i, '').split('/')[0] || url; }
}

/** "1440 × 900" */
export function sizeLabel(v: Pick<Viewport, 'width' | 'height'>): string { return `${v.width} × ${v.height}`; }

export interface ResultCounts { passed: number; fixed: number; failed: number; never: number }
/** Counts each test's most recent run result. */
export function countResults(tests: Pick<Test, 'lastRun'>[]): ResultCounts {
  const c: ResultCounts = { passed: 0, fixed: 0, failed: 0, never: 0 };
  for (const t of tests) {
    const r = t.lastRun?.result;
    if (r === 'pass') c.passed++; else if (r === 'healed') c.fixed++; else if (r === 'fail') c.failed++; else c.never++;
  }
  return c;
}

/** The most recent of the tests' last runs. */
export function latestRun(tests: Pick<Test, 'lastRun'>[]): RunSummary | undefined {
  let best: RunSummary | undefined;
  for (const t of tests) if (t.lastRun && (!best || t.lastRun.at > best.at)) best = t.lastRun;
  return best;
}

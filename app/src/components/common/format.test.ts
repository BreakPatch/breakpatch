import { describe, expect, it } from 'vitest';
import {
  clock, countResults, dayMonth, daysAgo, formatDateTime, formatDay, formatDuration, formatUpdated, formatWhen,
  hostOf, lastRunLine, latestRun, plural, sizeLabel,
} from './format';
import { impactSummary } from './ImpactDialog';

const NOW = new Date(2026, 8, 24, 15, 30).getTime();          // Thu 24 Sep 2026, 15:30
const t = (m: number, d: number, hh = 10, mm = 0, y = 2026) => new Date(y, m - 1, d, hh, mm).getTime();

describe('format', () => {
  it('counts calendar days, not 24 h windows', () => {
    expect(daysAgo(t(9, 24, 0, 5), NOW)).toBe(0);
    expect(daysAgo(t(9, 23, 23, 59), NOW)).toBe(1);
    expect(daysAgo(t(9, 2), NOW)).toBe(22);
  });

  it('formats clock and day-month', () => {
    expect(clock(t(9, 24, 6, 0))).toBe('06:00');
    expect(dayMonth(t(9, 2), NOW)).toBe('02 Sep');
    expect(dayMonth(t(12, 31, 10, 0, 2025), NOW)).toBe('31 Dec 2025');
  });

  it('formatWhen: Today, Yesterday with time; older as date', () => {
    expect(formatWhen(t(9, 24, 14, 52), NOW)).toBe('Today, 14:52');
    expect(formatWhen(t(9, 23, 11, 20), NOW)).toBe('Yesterday, 11:20');
    expect(formatWhen(t(9, 2, 11, 20), NOW)).toBe('02 Sep');
  });

  it('formatDay and formatUpdated', () => {
    expect(formatDay(t(9, 24, 9), NOW)).toBe('Today');
    expect(formatDay(t(9, 23), NOW)).toBe('Yesterday');
    expect(formatDay(t(8, 28), NOW)).toBe('28 Aug');
    expect(formatUpdated(t(9, 24, 14, 40), NOW)).toBe('Today, 14:40');
    expect(formatUpdated(t(9, 23, 16), NOW)).toBe('Yesterday');
    expect(formatUpdated(t(9, 12), NOW)).toBe('12 Sep');
  });

  it('formatDateTime always has the time', () => {
    expect(formatDateTime(t(9, 18, 11, 2), NOW)).toBe('18 Sep, 11:02');
    expect(formatDateTime(t(9, 24, 14, 40), NOW)).toBe('Today, 14:40');
  });

  it('lastRunLine', () => {
    expect(lastRunLine({ at: t(9, 24, 14, 52), by: 'Maria Lopez' }, NOW)).toBe('Last run today, 14:52 by Maria Lopez');
    expect(lastRunLine({ at: t(9, 23, 6, 0), by: 'Nightly suite' }, NOW)).toBe('Last run yesterday, 06:00 by Nightly suite');
    expect(lastRunLine({ at: t(9, 2), by: 'Tom Reid' }, NOW)).toBe('Last run 02 Sep by Tom Reid');
    expect(lastRunLine(undefined, NOW)).toBe('No runs yet');
  });

  it('formatDuration', () => {
    expect(formatDuration(41_000)).toBe('0:41');
    expect(formatDuration(68_000)).toBe('1:08');
    expect(formatDuration(134_400)).toBe('2:14');
    expect(formatDuration(3_723_000)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });

  it('plural, host and size', () => {
    expect(plural(1, 'test')).toBe('1 test');
    expect(plural(12, 'test')).toBe('12 tests');
    expect(plural(0, 'step')).toBe('0 steps');
    expect(hostOf('https://app.example.com/projects')).toBe('app.example.com');
    expect(hostOf('app.example.com/x')).toBe('app.example.com');
    expect(sizeLabel({ width: 1440, height: 900 })).toBe('1440 × 900');
  });

  it('counts results and finds the latest run', () => {
    const tests = [
      { lastRun: { result: 'pass' as const, at: 1, by: 'a' } },
      { lastRun: { result: 'healed' as const, at: 5, by: 'b' } },
      { lastRun: { result: 'fail' as const, at: 3, by: 'c' } },
      { lastRun: { result: 'pass' as const, at: 2, by: 'd' } },
      {},
    ];
    expect(countResults(tests)).toEqual({ passed: 2, fixed: 1, failed: 1, never: 1 });
    expect(latestRun(tests)?.by).toBe('b');
    expect(latestRun([{}])).toBeUndefined();
  });
});

describe('impactSummary', () => {
  it('splits latest and pinned', () => {
    const s = impactSummary({ name: 'Log in', usedBy: [{ testId: 'a', version: 'latest' }, { testId: 'b', version: 'latest' }, { testId: 'c', version: 4 }, { testId: 'd', version: 4 }] });
    expect(s.title).toBe('This will affect 4 tests.');
    expect(s.text).toBe('2 use the latest "Log in" and will pick up your changes on their next run. 2 are kept on version 4 and won\'t change.');
  });
  it('handles one test and mixed pins', () => {
    expect(impactSummary({ name: 'X', usedBy: [{ testId: 'a', version: 'latest' }] }).text).toBe('1 uses the latest "X" and will pick up your changes on their next run.');
    expect(impactSummary({ name: 'X', usedBy: [{ testId: 'a', version: 2 }, { testId: 'b', version: 3 }] }).text).toBe("2 are kept on earlier versions and won't change.");
  });
});

import { describe, expect, it } from 'vitest';
import type { App, Test } from '../../data/types';
import { doneCount, INITIAL_SUITE, nextIndex, planSuite, suiteCounts, suiteReducer, suiteResult, testOutcome, type SuiteAction, type SuiteRunView } from './suiteRun';

const test = (id: string) => ({ id, appId: 'web', name: id.toUpperCase() }) as Test;
const apps = [{ id: 'web', name: 'Web app' }] as App[];
const suite = { tests: [{ appId: 'web', testId: 'a' }, { appId: 'web', testId: 'gone' }, { appId: 'web', testId: 'b' }] };
const find = (_: string, id: string) => (id === 'gone' ? undefined : test(id));
const run = (s: SuiteRunView, ...as: SuiteAction[]) => as.reduce(suiteReducer, s);

describe('suite sequencing', () => {
  it('plans the tests in order and marks deleted ones', () => {
    const items = planSuite(suite, find, apps);
    expect(items.map(i => [i.name, i.appName, i.state])).toEqual([['A', 'Web app', 'waiting'], ['Test no longer exists', 'Web app', 'missing'], ['B', 'Web app', 'waiting']]);
  });
  it('runs one test after another and skips deleted ones', () => {
    let s = run(INITIAL_SUITE, { type: 'plan', items: planSuite(suite, find, apps) }, { type: 'begin', at: 1 });
    expect(nextIndex(s)).toBe(0);
    s = run(s, { type: 'testStart', index: 0 }, { type: 'testEnd', index: 0, state: 'passed', runId: 'r1' });
    expect(nextIndex(s)).toBe(2);
    s = run(s, { type: 'testStart', index: 2 }, { type: 'testEnd', index: 2, state: 'failed', note: 'x' });
    expect(nextIndex(s)).toBe(-1);
    s = run(s, { type: 'end', at: 9 });
    expect(s.phase).toBe('ended');
    expect(suiteCounts(s.items)).toEqual({ total: 3, passed: 1, fixed: 0, failed: 2, notRun: 0 });
    expect(suiteResult(suiteCounts(s.items))).toBe('failed');
    expect(s.items[0].runId).toBe('r1');
  });
  it('stops after the current test; the rest count as not run', () => {
    let s = run(INITIAL_SUITE, { type: 'plan', items: planSuite({ tests: [suite.tests[0], suite.tests[2]] }, find, apps) }, { type: 'begin', at: 1 }, { type: 'testStart', index: 0 }, { type: 'stop' });
    expect(nextIndex(s)).toBe(-1);
    s = run(s, { type: 'testEnd', index: 0, state: 'notRun' }, { type: 'end', at: 2 });
    expect(s.items.map(i => i.state)).toEqual(['notRun', 'notRun']);
    expect(doneCount(s.items)).toBe(0);
  });
  it('Run again starts fresh', () => {
    let s = run(INITIAL_SUITE, { type: 'plan', items: planSuite(suite, find, apps) }, { type: 'begin', at: 1 }, { type: 'testStart', index: 0 }, { type: 'testEnd', index: 0, state: 'failed' }, { type: 'end', at: 2 });
    s = run(s, { type: 'begin', at: 3 });
    expect(s.items.map(i => i.state)).toEqual(['waiting', 'missing', 'waiting']);
  });
  it('sums up results', () => {
    expect(testOutcome('pass', 0)).toBe('passed');
    expect(testOutcome('pass', 2)).toBe('fixed');
    expect(testOutcome('fail', 0)).toBe('failed');
    expect(suiteResult({ total: 2, passed: 1, fixed: 1, failed: 0, notRun: 0 })).toBe('passed_with_fixes');
    expect(suiteResult({ total: 2, passed: 2, fixed: 0, failed: 0, notRun: 0 })).toBe('passed');
  });
});

import { describe, expect, it } from 'vitest';
import type { Step } from '../../data/types';
import { callSecretNames, MissingGroupError, preorder, resolveSteps, rowIds, rowRefs, secretNames, type GroupLoader } from './resolve';

const st = (id: string, extra: Partial<Step> = {}): Step => ({ id, action: 'click', label: id, ...extra });
const group = (id: string, groupId: string, groupVersion: number | 'latest' = 'latest'): Step => ({ id, action: 'group', label: groupId, groupId, groupVersion });
const loop = (id: string, steps: Step[]): Step => ({ id, action: 'loop', label: 'Repeat', count: 2, steps });

const groups: Record<string, Record<string, Step[]>> = {
  login: { latest: [st('g1'), st('g2', { action: 'write', secretRef: 'PASSWORD' })], 2: [st('g1')] },
  outer: { latest: [st('o1'), group('o2', 'login')] },
};
const load: GroupLoader = async (id, v) => groups[id]?.[String(v)] ?? null;

describe('resolveSteps', () => {
  it('fills shared steps from the pinned or latest version', async () => {
    const out = await resolveSteps([st('a'), group('b', 'login'), group('c', 'login', 2)], load);
    expect(out[1].steps!.map(s => s.id)).toEqual(['g1', 'g2']);
    expect(out[2].steps!.map(s => s.id)).toEqual(['g1']);
  });
  it('resolves shared steps inside loops and inside other shared steps', async () => {
    const out = await resolveSteps([loop('L', [group('b', 'outer')])], load);
    expect(out[0].steps![0].steps![1].steps!.map(s => s.id)).toEqual(['g1', 'g2']);
  });
  it('fails plainly when shared steps are gone', async () => {
    await expect(resolveSteps([group('b', 'gone')], load)).rejects.toBeInstanceOf(MissingGroupError);
  });
  it('stops at runaway nesting', async () => {
    const self: GroupLoader = async () => [group('x', 'self')];
    await expect(resolveSteps([group('x', 'self')], self)).rejects.toThrow(/too deep/);
  });
});

describe('walks', () => {
  const steps = [st('a'), { ...group('b', 'login'), steps: [st('g1'), st('g2', { secretRef: 'PASSWORD' })] }, loop('L', [st('c'), st('d', { secretRef: 'EMAIL' })])];
  it('pre-order puts a loop or card before its children', () => {
    expect(preorder(steps).map(s => s.id)).toEqual(['a', 'b', 'g1', 'g2', 'L', 'c', 'd']);
  });
  it('lists each saved secret once', () => {
    expect(secretNames([...steps, st('e', { secretRef: 'EMAIL' })])).toEqual(['PASSWORD', 'EMAIL']);
  });
  it('maps shared-step children to their card and numbers them like the card', () => {
    const refs = rowRefs(steps);
    expect(rowIds(steps)).toEqual(['a', 'b', 'L', 'c', 'd']);
    expect(refs.get('g2')).toEqual({ rowId: 'b', number: '2.2' });
    expect(refs.get('d')).toEqual({ rowId: 'd', number: '5' });
  });
});

describe('callSecretNames', () => {
  it('names the saved secrets the set-up and clean-up headers use, once each', () => {
    expect(callSecretNames(
      { method: 'POST', url: 'https://api.x.dev', headers: [{ name: 'Authorization', secretRef: 'TOKEN' }, { name: 'X', value: 'y' }] },
      { method: 'DELETE', url: 'https://api.x.dev', headers: [{ name: 'Authorization', secretRef: 'TOKEN' }, { name: 'K', secretRef: 'KEY' }] },
    )).toEqual(['TOKEN', 'KEY']);
    expect(callSecretNames(undefined, { method: 'GET', url: 'https://x.dev' })).toEqual([]);
  });
});

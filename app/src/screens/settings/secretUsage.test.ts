import { describe, expect, it } from 'vitest';
import { countSecretUsage } from './secretUsage';
import type { Step } from '../../data/types';

const w = (id: string, secretRef: string): Step => ({ id, action: 'write', label: 'Write', secretRef });
const g = (id: string, groupId: string): Step => ({ id, action: 'group', label: 'Group', groupId });

describe('countSecretUsage', () => {
  it('counts each test once per secret, through loops and shared steps', () => {
    const groups = new Map<string, Step[]>([['login', [w('g1', 'EMAIL'), w('g2', 'PASSWORD')]]]);
    const tests = [
      { key: 'a/1', steps: [g('s1', 'login'), w('s2', 'EMAIL')] },
      { key: 'a/2', steps: [{ id: 'l', action: 'loop', label: 'Loop', steps: [w('x', 'ADMIN')] } as Step] },
      { key: 'b/1', steps: [g('s1', 'login')] },
      { key: 'b/2', steps: [] },
    ];
    const c = countSecretUsage(tests, groups);
    expect(c.get('EMAIL')).toBe(2);
    expect(c.get('PASSWORD')).toBe(2);
    expect(c.get('ADMIN')).toBe(1);
    expect(c.has('OTHER')).toBe(false);
  });

  it('ignores missing groups and cycles', () => {
    const groups = new Map<string, Step[]>([['a', [g('x', 'a'), w('y', 'S')]]]);
    const c = countSecretUsage([{ key: 't', steps: [g('1', 'a'), g('2', 'missing')] }], groups);
    expect(c.get('S')).toBe(1);
  });
});

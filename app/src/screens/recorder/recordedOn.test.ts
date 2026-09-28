import { describe, expect, it } from 'vitest';
import type { RecordedOn } from '../../data/types';
import type { SystemInfo } from '../../engine';
import { recordedOnForSave } from './recordedOn';

const mac: RecordedOn = { os: 'macOS', osVersion: '15.3', arch: 'arm64', chromium: '140.0.7339.16' };
const before: RecordedOn = { os: 'macOS', osVersion: '14.6', arch: 'arm64', chromium: '131.0.1.1' };
const engine = (system?: RecordedOn, fail = false) => ({
  systemInfo: async () => { if (fail) throw new Error('engine stopped'); return { system } as SystemInfo; },
});

describe('where a save was recorded', () => {
  it('is this system once a step was recorded or re-recorded', async () => {
    expect(await recordedOnForSave(engine(mac), true, before)).toEqual(mac);
    expect(await recordedOnForSave(engine(mac), true, undefined)).toEqual(mac);
  });
  it('stays as it was for edits alone, an older engine or one that can\'t answer', async () => {
    expect(await recordedOnForSave(engine(mac), false, before)).toEqual(before);
    expect(await recordedOnForSave(engine(undefined), true, before)).toEqual(before);
    expect(await recordedOnForSave(engine(mac, true), true, before)).toEqual(before);
    expect(await recordedOnForSave(engine(mac), false, undefined)).toBeUndefined();
  });
});

// A Call step (issue #44) raises the tests folder's format, as a phone test does (devices.test.tsx):
// apps from before can't run or edit one, so they refuse the folder instead.
import { describe, expect, it } from 'vitest';
import type { Step } from '../types';
import { usesCallSteps } from '../../lib/calls';
import { initFolder } from './folder';
import { LocalBackend } from './localBackend';
import { CALL_SCHEMA_VERSION, DEVICE_SCHEMA_VERSION, fromFileText, NEWEST_READ_SCHEMA_VERSION, SCHEMA_VERSION } from './format';
import { MemoryStorage } from './storage';

const APP = 'https://app.acme.com';
const call = (): Step => ({ id: 'c1', action: 'call', label: 'Call POST api.acme.com/test/orders/paid',
  call: { method: 'POST', url: 'https://api.acme.com/test/orders/paid', body: '{"paid": true}', headers: [{ name: 'Authorization', secretRef: 'API_TOKEN' }] } });

describe('the tests folder format', () => {
  const ROOT = '/tests';
  const person = { uid: 'u', name: 'Ana', email: 'ana@acme.com' };
  const LAPTOP = { width: 1440, height: 900, dpr: 1 as const };
  const meta = async (st: MemoryStorage) => fromFileText<{ schemaVersion: number }>((await st.read(`${ROOT}/breakpatch.json`))!).schemaVersion;

  it('goes up to 3 with the first Call step saved, so apps from before refuse the folder rather than fail to run it', async () => {
    expect(CALL_SCHEMA_VERSION).toBe(3);
    expect(CALL_SCHEMA_VERSION).toBeGreaterThan(DEVICE_SCHEMA_VERSION);
    expect(NEWEST_READ_SCHEMA_VERSION).toBe(CALL_SCHEMA_VERSION);
    const st = new MemoryStorage();
    await st.mkdir(ROOT);
    await initFolder(st, ROOT);
    const b = await LocalBackend.open({ storage: st, path: ROOT, person, live: false });
    try {
      const app = await b.addApp({ name: 'Web app', baseUrl: APP, defaultViewport: LAPTOP });
      const t = await b.createTest({ appId: app.id, name: 'Pay', startUrl: APP, viewport: LAPTOP });
      await b.saveTest(app.id, t.id, [{ id: 'w', action: 'waitFor', label: 'Wait 1 seconds', durationMs: 1000 }]);
      expect(await meta(st)).toBe(SCHEMA_VERSION);                       // no Call steps: as before
      await b.saveTest(app.id, t.id, [{ id: 'l', action: 'loop', label: 'Repeat', count: 1, steps: [call()] }]);
      expect(await meta(st)).toBe(CALL_SCHEMA_VERSION);
      const saved = fromFileText<{ steps: Step[] }>((await st.read(`${ROOT}/apps/${app.id}/tests/${t.id}.json`))!);
      expect(saved.steps[0].steps![0]).toEqual(call());
    } finally { b.close(); }
  });

  it('goes up with shared steps that have one too', async () => {
    const st = new MemoryStorage();
    await st.mkdir(ROOT);
    await initFolder(st, ROOT);
    const b = await LocalBackend.open({ storage: st, path: ROOT, person, live: false });
    try {
      const app = await b.addApp({ name: 'Web app', baseUrl: APP, defaultViewport: LAPTOP });
      const g = await b.createGroup(app.id, 'Log in', '', [{ id: 'w', action: 'write', label: 'Write', text: 'x' }]);
      expect(await meta(st)).toBe(SCHEMA_VERSION);
      await b.saveGroup(app.id, g.id, [{ id: 'w', action: 'write', label: 'Write the value OTP', valueRef: 'OTP' }]);
      expect(await meta(st)).toBe(CALL_SCHEMA_VERSION);
    } finally { b.close(); }
  });

  it('knows a Call step, or a Write of a value one keeps, at any depth', () => {
    expect(usesCallSteps([{ action: 'click' }, { action: 'group', steps: [{ action: 'loop', steps: [{ action: 'call' }] }] }])).toBe(true);
    expect(usesCallSteps([{ action: 'write', valueRef: 'CODE' }])).toBe(true);
    expect(usesCallSteps([{ action: 'write', text: 'x' }, null, 'x'])).toBe(false);
    expect(usesCallSteps(undefined)).toBe(false);
  });
});

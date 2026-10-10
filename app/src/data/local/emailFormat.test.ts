// A Wait for an email step (Breakpatch Team, issue #12) raises the tests folder's format to 4, as a
// Call step raises it to 3 (callFormat.test.ts): apps from before don't know the step, so they
// refuse the folder rather than show it as nothing and save over it.
import { describe, expect, it } from 'vitest';
import type { Step } from '../types';
import { usesEmail, usesEmailSteps } from '../../lib/email';
import { initFolder } from './folder';
import { LocalBackend } from './localBackend';
import { CALL_SCHEMA_VERSION, EMAIL_SCHEMA_VERSION, fromFileText, NEWEST_READ_SCHEMA_VERSION, SCHEMA_VERSION } from './format';
import { MemoryStorage } from './storage';

const APP = 'https://app.acme.com';
const wait = (): Step => ({ id: 'e1', action: 'emailWait', label: 'Wait for an email with a code', email: { to: '{email}', pick: 'code', subjectContains: 'Your code' }, timeoutMs: 60000 });

describe('the tests folder format and Wait for an email steps', () => {
  const ROOT = '/tests';
  const person = { uid: 'u', name: 'Ana', email: 'ana@acme.com' };
  const LAPTOP = { width: 1440, height: 900, dpr: 1 as const };
  const meta = async (st: MemoryStorage) => fromFileText<{ schemaVersion: number }>((await st.read(`${ROOT}/breakpatch.json`))!).schemaVersion;

  it('goes up to 4 with the first one saved, and the step is kept as it was', async () => {
    expect(EMAIL_SCHEMA_VERSION).toBe(4);
    expect(EMAIL_SCHEMA_VERSION).toBeGreaterThan(CALL_SCHEMA_VERSION);
    expect(NEWEST_READ_SCHEMA_VERSION).toBe(EMAIL_SCHEMA_VERSION);
    const st = new MemoryStorage();
    await st.mkdir(ROOT);
    await initFolder(st, ROOT);
    const b = await LocalBackend.open({ storage: st, path: ROOT, person, live: false });
    try {
      const app = await b.addApp({ name: 'Web app', baseUrl: APP, defaultViewport: LAPTOP });
      const t = await b.createTest({ appId: app.id, name: 'Sign up', startUrl: APP, viewport: LAPTOP });
      // {email} in a Write step alone doesn't: an older app types it as it is and the run fails, never passes.
      await b.saveTest(app.id, t.id, [{ id: 'w', action: 'write', label: 'Write', text: '{email}' }]);
      expect(await meta(st)).toBe(SCHEMA_VERSION);
      await b.saveTest(app.id, t.id, [{ id: 'w', action: 'write', label: 'Write', text: '{email}' }, { id: 'l', action: 'loop', label: 'Repeat', count: 1, steps: [wait()] }]);
      expect(await meta(st)).toBe(EMAIL_SCHEMA_VERSION);
      const saved = fromFileText<{ steps: Step[] }>((await st.read(`${ROOT}/apps/${app.id}/tests/${t.id}.json`))!);
      expect(saved.steps[1].steps![0]).toEqual(wait());
      // Read back as saved.
      const again = await LocalBackend.open({ storage: st, path: ROOT, person, live: false });
      try { expect((await again.version(app.id, t.id, 1))?.steps[1].steps?.[0]).toEqual(wait()); } finally { again.close(); }
    } finally { b.close(); }
  });

  it('a folder at 4 from a newer app than one that reads 3 is refused by that one; this one reads 1 to 4', async () => {
    const st = new MemoryStorage();
    await st.mkdir(ROOT);
    await initFolder(st, ROOT);
    await st.write(`${ROOT}/breakpatch.json`, JSON.stringify({ format: 'breakpatch', schemaVersion: EMAIL_SCHEMA_VERSION, name: 'Tests' }));
    const b = await LocalBackend.open({ storage: st, path: ROOT, person, live: false });
    b.close();
    await st.write(`${ROOT}/breakpatch.json`, JSON.stringify({ format: 'breakpatch', schemaVersion: EMAIL_SCHEMA_VERSION + 1, name: 'Tests' }));
    await expect(LocalBackend.open({ storage: st, path: ROOT, person, live: false })).rejects.toThrow(/newer/i);
  });

  it('knows a Wait for an email step at any depth, and what needs the test inbox', () => {
    expect(usesEmailSteps([{ action: 'click' }, { action: 'group', steps: [{ action: 'loop', steps: [{ action: 'emailWait' }] }] }])).toBe(true);
    expect(usesEmailSteps([{ action: 'write', text: '{email}' }, null, 'x'])).toBe(false);
    expect(usesEmailSteps(undefined)).toBe(false);
    const w = (text: string): Step => ({ id: 'w', action: 'write', label: 'W', text });
    expect(usesEmail([w('{email}')])).toBe(true);
    expect(usesEmail([{ id: 'g', action: 'navigate', label: 'Go', url: '{emailLink}' }])).toBe(true);
    expect(usesEmail([{ id: 'c', action: 'call', label: 'Call', call: { method: 'POST', url: 'https://api.acme.com/u', body: '{"email": "{email}"}' } }])).toBe(true);
    expect(usesEmail([w('Note {i}'), wait()])).toBe(true);
    expect(usesEmail([w('Note {i} at {time}')])).toBe(false);
  });
});

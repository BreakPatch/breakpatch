import { describe, expect, it } from 'vitest';
import { folderConnection, workspaceConnection, type Connection } from '../state/connections';
import type { Workspace } from '../data/types';
import { isOpenLink, linkWorkspaceOf, openLinkFor, parseOpenLink, resolveOpenLink, routeOf, type ResolveOptions } from './openLinks';
import type { Backend } from '../data/backend';

const ws: Workspace = { name: 'Acme', domain: 'acme.com', database: 'breakpatch', config: { apiKey: 'k', authDomain: 'a', projectId: 'acme-qa', appId: '1' } };
const hosted: Workspace = { ...ws, name: 'Acme Cloud', domain: '', database: '(default)', tenant: 'k3v9x2m8q1w7e4r6t0y5u2i8o3p1', config: { ...ws.config, projectId: 'breakpatch-cloud' } };
const FOLDER = 'a1b2c3d4e5f60718293a';

describe('open links', () => {
  it('name a test or a suite in a workspace, readably, and read back the same', () => {
    const test = openLinkFor('team:acme-qa/breakpatch', { kind: 'test', appId: 'web-app', testId: 'log-in' });
    expect(test).toBe('breakpatch://open?ws=team:acme-qa/breakpatch&path=apps/web-app/tests/log-in');
    expect(parseOpenLink(test)).toEqual({ ws: 'team:acme-qa/breakpatch', target: { kind: 'test', appId: 'web-app', testId: 'log-in' } });
    const suite = openLinkFor(`folder:${FOLDER}`, { kind: 'suite', suiteId: 'smoke' });
    expect(parseOpenLink(` ${suite} `)).toEqual({ ws: `folder:${FOLDER}`, target: { kind: 'suite', suiteId: 'smoke' } });
    // Firestore's ids, the default database, a hosted workspace, the demo, and encoded forms.
    for (const w of ['team:acme-qa/-default-', 'hosted:k3v9x2m8q1w7e4r6t0y5u2i8o3p1', 'demo']) {
      const l = openLinkFor(w, { kind: 'test', appId: 'Xk2pQ9aZ', testId: 'v1.2_login' });
      expect(parseOpenLink(l)?.ws).toBe(w);
      expect(parseOpenLink(l.replace(/\?(.*)$/, (_, q: string) => `?${q.replace(/:/g, '%3A').replace(/\//g, '%2F')}`))?.ws).toBe(w);
    }
    expect(isOpenLink('breakpatch://open?ws=demo')).toBe(true);
    expect(isOpenLink('breakpatch://report/a/b')).toBe(false);
    expect(isOpenLink('breakpatch://connect#c=x')).toBe(false);
    expect(isOpenLink('breakpatch://opener?x')).toBe(false);
  });

  it('go to the recorder for a test and the editor for a suite', () => {
    expect(routeOf({ kind: 'test', appId: 'web', testId: 't1' })).toBe('/apps/web/tests/t1/record');
    expect(routeOf({ kind: 'suite', suiteId: 's1' })).toBe('/suites/s1');
  });

  it('refuse anything that isn’t exactly one, so nothing in a link walks a path or picks a file', () => {
    const ok = 'breakpatch://open?ws=team:acme-qa/breakpatch&path=apps/web/tests/t1';
    expect(parseOpenLink(ok)).not.toBeNull();
    for (const bad of [
      'breakpatch://open',
      'breakpatch://open?ws=team:acme-qa/breakpatch',
      'breakpatch://open?path=apps/web/tests/t1',
      ok.replace('t1', '..'), ok.replace('t1', '.hidden'), ok.replace('web', '..'), ok.replace('t1', '%2E%2E'),
      ok.replace('tests/t1', 'tests/t1/record'), ok.replace('tests/t1', 'tests/a/../b'), ok.replace('tests/t1', 'tests/a%2Fb'),
      ok.replace('tests/t1', 'tests/a%5Cb'), ok.replace('tests/t1', 'tests/a%00'), ok.replace('tests/t1', 'tests/'), ok.replace('apps/web/tests/t1', 'apps/web/runs/r1'),
      ok.replace('apps/web/tests/t1', 'suites/a/b'), ok.replace('apps/web/tests/t1', '/suites/s1'), `${ok}&path=suites/s1`, `${ok}&ws=demo`,
      ok.replace('t1', 'x'.repeat(129)),
      ok.replace('team:acme-qa/breakpatch', 'team:../breakpatch'), ok.replace('team:acme-qa/breakpatch', 'team:acme-qa/x/y'),
      ok.replace('team:acme-qa/breakpatch', 'local:1234abcd1234abcd'), ok.replace('team:acme-qa/breakpatch', 'folder:../../etc'),
      ok.replace('team:acme-qa/breakpatch', 'folder:/Users/ana/tests'), ok.replace('team:acme-qa/breakpatch', 'hosted:short'),
      ok.replace('breakpatch://open', 'breakpatch://report'), ok.replace('breakpatch://open', 'breakpatch://open.evil.com'),
      ok.replace('breakpatch://open', 'breakpatch://user@open'), ok.replace('breakpatch://open?', 'breakpatch://open/x?'),
      ok.replace('breakpatch:', 'https:'), `${ok}${'&x=1'.repeat(600)}`,
    ]) expect(parseOpenLink(bad), bad).toBeNull();
  });

  it('can’t be made for an id a link can’t carry', () => {
    expect(() => openLinkFor('demo', { kind: 'test', appId: 'web', testId: 'Log in' })).toThrow(/Rename its file/);
    expect(() => openLinkFor('local:abc', { kind: 'suite', suiteId: 's' })).toThrow();
  });

  it('name the workspace by its connection id, and a tests folder by its own id', async () => {
    expect(await linkWorkspaceOf({ workspace: ws } as Backend)).toBe('team:acme-qa/breakpatch');
    expect(await linkWorkspaceOf({ workspace: hosted } as Backend)).toBe('hosted:k3v9x2m8q1w7e4r6t0y5u2i8o3p1');
    expect(await linkWorkspaceOf({ workspace: null, folderId: async () => FOLDER } as unknown as Backend)).toBe(`folder:${FOLDER}`);
    expect(await linkWorkspaceOf({ workspace: null } as Backend)).toBeNull();
    expect(await linkWorkspaceOf(null)).toBeNull();
  });
});

describe('finding the workspace on this Mac', () => {
  const a = folderConnection('/Users/ana/web/tests', 'web', 10);
  const b = folderConnection('/Users/ana/copy/tests', 'copy', 20);
  const c = folderConnection('/Users/ana/other', 'other', 30);
  const team = workspaceConnection(ws, 5);
  const ids: Record<string, string | null> = { [a.local!.path]: FOLDER, [b.local!.path]: FOLDER, [c.local!.path]: null };
  const opts = (o: Partial<ResolveOptions> = {}): ResolveOptions => ({
    list: [a, b, c, team], activeId: null, canOpen: () => true, teamEdition: true, folderIdOf: async p => ids[p] ?? null, ...o,
  });
  const link = (w: string) => ({ ws: w, target: { kind: 'test' as const, appId: 'web', testId: 't1' } });
  const conn = (r: Awaited<ReturnType<typeof resolveOpenLink>>) => ('connection' in r ? r.connection : null) as Connection | null;

  it('finds a tests folder by its own id wherever it is: the open copy, else the one opened last', async () => {
    expect(conn(await resolveOpenLink(link(`folder:${FOLDER}`), opts()))?.id).toBe(b.id);
    expect(conn(await resolveOpenLink(link(`folder:${FOLDER}`), opts({ activeId: a.id })))?.id).toBe(a.id);
    // A folder that can't be read just isn't it.
    expect(conn(await resolveOpenLink(link(`folder:${FOLDER}`), opts({ folderIdOf: async p => { if (p === b.local!.path) throw new Error('gone'); return ids[p] ?? null; } })))?.id).toBe(a.id);
  });

  it('finds a workspace by its connection id', async () => {
    expect(conn(await resolveOpenLink(link('team:acme-qa/breakpatch'), opts()))?.id).toBe(team.id);
  });

  it('says plainly when the workspace or folder isn’t on this Mac, or is a Team one in Community', async () => {
    const r1 = await resolveOpenLink(link('folder:ffffffffffffffff'), opts());
    expect('problem' in r1 && r1.problem.title).toBe("That tests folder isn't open on this Mac");
    const r2 = await resolveOpenLink(link('team:other-project/breakpatch'), opts());
    expect('problem' in r2 && r2.problem.title).toBe("That workspace isn't on this Mac");
    const r3 = await resolveOpenLink(link('team:acme-qa/breakpatch'), opts({ teamEdition: false, canOpen: x => x.kind === 'local' }));
    expect('problem' in r3 && r3.problem.title).toBe('That test is in a Team workspace');
    // One this edition can't open counts as not here.
    const r4 = await resolveOpenLink(link('team:acme-qa/breakpatch'), opts({ canOpen: x => x.kind === 'local' }));
    expect('problem' in r4 && r4.problem.title).toBe("That workspace isn't on this Mac");
  });
});

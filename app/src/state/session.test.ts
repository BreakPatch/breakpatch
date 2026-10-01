// Switching workspaces (session.ts): the one open closes, and only the open backend's person is
// ever the session's user.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Backend } from '../data/backend';
import type { Person, Workspace } from '../data/types';
import { edition } from '../edition';
import { connections, workspaceConnection } from './connections';
import { bootSession, useSession } from './session';

const wsOf = (name: string): Workspace => ({ name, domain: 'acme.com', database: 'breakpatch', config: { apiKey: 'k', authDomain: 'a', projectId: name.toLowerCase(), appId: '1' } });
const A = wsOf('Acme'), B = wsOf('Globex');
const person = (uid: string): Person => ({ uid, name: uid, email: `${uid}@acme.com` });

/** A workspace backend that says who's signed in and counts its listeners. */
class FakeBackend {
  readonly kind = 'firebase' as const;
  listeners = new Set<(u: Person | null) => void>();
  closed = false;
  readonly workspace: Workspace;
  user: Person | null;
  constructor(workspace: Workspace, user: Person | null) { this.workspace = workspace; this.user = user; }
  currentUser() { return this.user; }
  onUser(l: (u: Person | null) => void) { this.listeners.add(l); l(this.user); return () => { this.listeners.delete(l); }; }
  emit(u: Person | null) { this.user = u; this.listeners.forEach(l => l(u)); }
  close() { this.closed = true; }
  async signOut() {}
}

const opened: FakeBackend[] = [];
const realOpen = edition.openWorkspace;
beforeEach(() => {
  localStorage.clear(); connections.reloadForTests(); opened.length = 0;
  edition.openWorkspace = async ws => { const b = new FakeBackend(ws, person(`${ws.name}-me`)); opened.push(b); return b as unknown as Backend; };
});
afterEach(() => {
  edition.openWorkspace = realOpen;
  useSession.setState({ workspace: null, local: null, backend: null, user: null });
  localStorage.clear();
});

describe('switching workspaces', () => {
  it("closes the old backend, and its late sign-in events never reach the session", async () => {
    useSession.setState({ workspace: A });
    await bootSession();
    const [a] = opened;
    expect(useSession.getState().user?.uid).toBe('Acme-me');
    await useSession.getState().switchTo(workspaceConnection(B));
    const [, b] = opened;
    expect(a.closed).toBe(true);
    expect(a.listeners.size).toBe(0);
    expect(useSession.getState().user?.uid).toBe('Globex-me');
    // Workspace A's auth state changes while B is open: B's person stays.
    a.emit(person('someone-at-acme'));
    expect(useSession.getState().user?.uid).toBe('Globex-me');
    // B's own changes still arrive, and switching back leaves B quiet in turn.
    b.emit(person('Globex-other'));
    expect(useSession.getState().user?.uid).toBe('Globex-other');
    await useSession.getState().switchTo(workspaceConnection(A));
    expect(b.closed && b.listeners.size === 0).toBe(true);
    b.emit(null);
    expect(useSession.getState().user?.uid).toBe('Acme-me');
    expect(opened[2].listeners.size).toBe(1);
  });

  it('opens a hosted workspace from the list, and connecting one remembers it as hosted', async () => {
    const H: Workspace = { name: 'Acme Cloud', domain: '', database: '(default)', tenant: 'k3v9x2m8q1w7e4r6t0y5u2i8o3p1', config: { apiKey: 'k', authDomain: 'a', projectId: 'breakpatch-cloud', appId: '1' } };
    await useSession.getState().connect(A);
    await useSession.getState().switchTo(workspaceConnection(H));
    expect(useSession.getState().workspace).toEqual(H);
    expect(opened.at(-1)?.workspace).toEqual(H);
    const { list, activeId } = (await import('./connections')).useConnections.getState();
    expect(activeId).toBe('hosted:k3v9x2m8q1w7e4r6t0y5u2i8o3p1');
    expect(list.find(c => c.id === activeId)).toMatchObject({ kind: 'hosted', hosted: { workspaceId: H.tenant } });
  });
});

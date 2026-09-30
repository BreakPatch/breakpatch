// The connection id is a persisted contract (connectionIds.ts): these exact values must never
// change, or licences, usage counts and a move's journal on people's Macs are orphaned. The shell
// checks the same characters in licence.rs `valid_ws_key`.
import { describe, expect, it } from 'vitest';
import type { Workspace } from '../data/types';
import { folderConnectionId, workspaceConnectionId } from './connectionIds';

const ws = (projectId: string, database: string, apiKey = 'k'): Workspace => ({ name: 'Acme', domain: 'acme.com', database, config: { apiKey, authDomain: 'a', projectId, appId: '1' } });
/** licence.rs `valid_ws_key`, as it is. */
const validWsKey = (k: string) => k.length > 0 && k.length <= 200 && /^[A-Za-z0-9._:/@-]+$/.test(k);

describe('connection ids', () => {
  it('pins the format of each kind', () => {
    expect(workspaceConnectionId(ws('acme-qa', 'breakpatch'))).toBe('team:acme-qa/breakpatch');
    expect(workspaceConnectionId(ws('acme-qa', 'qa-2'))).toBe('team:acme-qa/qa-2');
    // Firestore's (default) database: no parentheses in a Keychain key.
    expect(workspaceConnectionId(ws('acme-qa', '(default)'))).toBe('team:acme-qa/-default-');
    expect(workspaceConnectionId(ws('demo-breakpatch', 'breakpatch', 'demo'))).toBe('demo');
    expect(folderConnectionId('/Users/ana/web/tests')).toBe('local:4d937c00b1d4760a');
    expect(folderConnectionId('/Users/ana/web/tests/')).toBe('local:4d937c00b1d4760a');
  });

  it('makes only keys the shell accepts', () => {
    for (const id of [workspaceConnectionId(ws('acme-qa', 'breakpatch')), workspaceConnectionId(ws('acme-qa', '(default)')), folderConnectionId('/Users/ana/Tests with spaces/é'), 'demo']) {
      expect(validWsKey(id), id).toBe(true);
    }
  });
});

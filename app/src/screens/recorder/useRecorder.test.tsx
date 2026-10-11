import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getEngine } from '../../engine';
import { secretFor, useRecorder } from './useRecorder';
import { useSession } from '../../state/session';
import { DEMO_WORKSPACE } from '../../data/demo/demoBackend';

beforeEach(() => { useSession.setState({ workspace: DEMO_WORKSPACE, local: null }); });
afterEach(() => { vi.restoreAllMocks(); });

describe('recording a "Write saved secret" step', () => {
  it('sends the value to the engine with that call, and never keeps it in the step', async () => {
    const engine = getEngine();
    const spy = vi.spyOn(engine, 'recordPoint').mockImplementation(async p => ({ id: 's1', action: 'write', label: 'Write saved secret', secretRef: p.secretRef }));
    const onError = vi.fn();
    const { result } = renderHook(() => useRecorder({ viewport: { width: 1440, height: 900 }, onError, appUrl: 'https://app.example.com' }));
    act(() => { result.current.setAction('write'); result.current.setOptions({ writeSource: 'secret', secretRef: 'ACME_TEST_PASSWORD' }); });
    act(() => { result.current.send(); });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // With where it's recorded (lib/secretScope.ts): the open demo workspace.
    expect(spy.mock.calls[0][0]).toEqual({ action: 'write', secretRef: 'ACME_TEST_PASSWORD', secrets: { ACME_TEST_PASSWORD: 'demo-password' }, workspace: 'demo' });
    await waitFor(() => expect(result.current.steps).toHaveLength(1));
    expect(JSON.stringify(result.current.steps)).not.toContain('demo-password');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reads only the one secret, and nothing for other steps', async () => {
    expect(await secretFor(undefined, 'https://app.example.com')).toBeUndefined();
    expect(await secretFor('ACME_TEST_EMAIL', 'https://app.example.com')).toEqual({ secrets: { ACME_TEST_EMAIL: 'qa@acme.example' }, workspace: 'demo' });
    expect(await secretFor('NOT_ON_THIS_MAC', 'https://app.example.com')).toEqual({ secrets: {}, workspace: 'demo' });
  });
});

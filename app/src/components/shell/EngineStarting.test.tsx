import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSystem } from '../../state/system';
import { ENGINE_STARTED_KEY } from '../../state/system';
import { appVersion } from '../../platform';
import { EngineStarting, FIRST_STARTING_TEXT, STARTING_TEXT } from './EngineStarting';

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetModules(); });

describe('Starting Breakpatch…', () => {
  it('shows from the start until the engine first answers, and never on the setup screen', () => {
    useSystem.setState({ engineReady: false, firstEngineStart: false });
    render(<MemoryRouter initialEntries={['/']}><EngineStarting /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent(STARTING_TEXT);
    act(() => useSystem.getState().markEngineReady());
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();
    useSystem.setState({ engineReady: false });
    render(<MemoryRouter initialEntries={['/setup']}><EngineStarting /></MemoryRouter>);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ends on the engine\'s first reply, which the app asks for at once', async () => {
    useSystem.setState({ engineReady: false });
    let answer: (v: unknown) => void = () => undefined;
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => new Promise(r => { answer = r; })) }));
    vi.doMock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }));
    const { SidecarEngine } = await import('../../engine/sidecarEngine');
    const { useSystem: sys } = await import('../../state/system');
    sys.setState({ engineReady: false });
    new SidecarEngine();
    const { invoke } = await import('@tauri-apps/api/core');
    expect(invoke).toHaveBeenCalledWith('engine_request', { method: 'system.info', params: {} });
    expect(sys.getState().engineReady).toBe(false);
    await act(async () => { answer({}); await Promise.resolve(); });
    expect(sys.getState().engineReady).toBe(true);
  });

  it('says the first start takes longer only on a first start of this version on this Mac', async () => {
    localStorage.removeItem(ENGINE_STARTED_KEY);
    vi.resetModules();
    const fresh = await import('../../state/system');
    expect(fresh.useSystem.getState().firstEngineStart).toBe(true);
    fresh.useSystem.getState().markEngineReady();
    expect(localStorage.getItem(ENGINE_STARTED_KEY)).toBe(appVersion());
    vi.resetModules();
    expect((await import('../../state/system')).useSystem.getState().firstEngineStart).toBe(false);     // the next launch
    localStorage.setItem(ENGINE_STARTED_KEY, '0.0.1');                                                 // an older version's engine
    vi.resetModules();
    expect((await import('../../state/system')).useSystem.getState().firstEngineStart).toBe(true);
    useSystem.setState({ engineReady: false, firstEngineStart: true });
    render(<MemoryRouter initialEntries={['/']}><EngineStarting /></MemoryRouter>);
    expect(screen.getByRole('status')).toHaveTextContent(FIRST_STARTING_TEXT);
    act(() => useSystem.setState({ firstEngineStart: false }));
    expect(screen.getByRole('status')).not.toHaveTextContent('first start');
  });
});

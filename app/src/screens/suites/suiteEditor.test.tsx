// The suite editor's order: moving a test up or down swaps it with its neighbour where they are in
// the suite, so tests it doesn't list (in Recently deleted) keep their places.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { DemoBackend } from '../../data/demo/demoBackend';
import { useSession } from '../../state/session';
import SuiteEditorScreen from './SuiteEditorScreen';
import { swapTests } from './suiteOrder';

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
window.matchMedia ??= ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;

const VP = { width: 1440, height: 900, dpr: 1 as const };
afterEach(() => { cleanup(); useSession.setState({ local: null, user: null }); });

describe('moving a test in a suite', () => {
  it('keeps a test in Recently deleted where it was', async () => {
    const backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
    useSession.setState({ backend, workspace: null });
    const app = await backend.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: VP });
    const ids: string[] = [];
    for (const name of ['Log in', 'Search', 'Log out']) ids.push((await backend.createTest({ appId: app.id, name, startUrl: app.baseUrl, viewport: VP })).id);
    const suite = await backend.saveSuite(null, { name: 'Smoke', tests: ids.map(testId => ({ appId: app.id, testId })), schedule: null });
    await backend.deleteTest(app.id, ids[1]);
    render(
      <MemoryRouter initialEntries={[`/suites/${suite.id}`]}>
        <Routes><Route path="/suites/:suiteId" element={<SuiteEditorScreen />} /></Routes>
      </MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Move Log out up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    const order = () => new Promise<string[]>(res => { const off = backend.suites(v => { queueMicrotask(() => off()); res(v.find(x => x.id === suite.id)!.tests.map(t => t.testId)); }); });
    await waitFor(async () => expect(await order()).toEqual([ids[2], ids[1], ids[0]]));
  });

  it('changes nothing for a test that isn’t in the suite', () => {
    const picked = [{ appId: 'web', testId: 'a' }, { appId: 'web', testId: 'b' }];
    expect(swapTests(picked, picked[0], { appId: 'web', testId: 'x' })).toBe(picked);
  });
});

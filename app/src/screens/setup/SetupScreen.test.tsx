// Setup's list while the engine starts: the first row is working at once, never idle.
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { SystemInfo } from '../../engine/engine';
import { useSystem } from '../../state/system';

const engine = vi.hoisted(() => {
  let answer: (i: unknown) => void = () => {};
  const progress: ((p: unknown) => void)[] = [];
  return {
    answer: (i: unknown) => answer(i),
    progress: (p: unknown) => progress.forEach(h => h(p)),
    fake: {
      on: (_: string, cb: (p: unknown) => void) => { progress.push(cb); return () => {}; },
      systemInfo: () => new Promise(r => { answer = r; }),
      installBrowser: () => new Promise(() => {}),
      downloadModel: () => new Promise(() => {}),
      pauseSetup: async () => {},
    },
  };
});
vi.mock('../../engine', async orig => ({ ...(await orig<typeof import('../../engine')>()), getEngine: () => engine.fake }));

const { default: SetupScreen } = await import('./SetupScreen');

afterEach(cleanup);

const rows = () => within(screen.getByRole('list', { name: 'Setup' })).getAllByRole('listitem');

it('turns the first spinner at once, saying "Starting…" until the engine says how far it is', async () => {
  useSystem.setState({ engineReady: false, firstEngineStart: true });
  render(<MemoryRouter><SetupScreen /></MemoryRouter>);
  const [browser, mac, model] = rows();
  expect(browser).toHaveClass('busy');
  expect(browser).toHaveTextContent('Installing the test browserStarting…');
  expect(browser).toHaveTextContent('The first start takes a little longer.');
  expect(mac).toHaveClass('waiting');
  expect(model).toHaveClass('waiting');

  await act(async () => {
    useSystem.setState({ engineReady: true });
    engine.answer({ memoryGb: 16, chip: 'M2', os: 'macOS', engineVersion: '0', edition: 'community', browser: { installed: false }, model: { installed: false } } satisfies SystemInfo);
  });
  expect(rows()[0]).toHaveClass('busy');
  expect(rows()[0]).toHaveTextContent('Starting…');
  act(() => engine.progress({ task: 'browser', state: 'busy', doneBytes: 30, totalBytes: 100 }));
  expect(rows()[0]).toHaveTextContent('30%');
  expect(rows()[0]).not.toHaveTextContent('Starting…');
});

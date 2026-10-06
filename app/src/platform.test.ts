import { afterEach, describe, expect, it, vi } from 'vitest';

// The shell's side, as onWorkspaceLink sees it: the deep-link plugin (the launch's link, then each
// later one: on Linux and Windows a second launch hands its link over), the `workspace-file` event
// (a file opened while the app runs, from a second launch on Linux and Windows) and the file the
// app was launched with, kept by the shell until asked for.
const fake = vi.hoisted(() => ({
  current: null as string[] | null,
  launchFile: null as string | null,
  urlListeners: [] as ((urls: string[]) => void)[],
  fileListeners: [] as ((e: { payload: string }) => void)[],
  unlistened: [] as string[],
}));

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  getCurrent: async () => fake.current,
  onOpenUrl: async (cb: (urls: string[]) => void) => { fake.urlListeners.push(cb); return () => fake.unlistened.push('url'); },
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, cb: (e: { payload: string }) => void) => {
    expect(name).toBe('workspace-file');
    fake.fileListeners.push(cb);
    return () => fake.unlistened.push('file');
  },
}));
vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    expect(cmd).toBe('workspace_file_take');
    const f = fake.launchFile; fake.launchFile = null; return f;
  },
}));

import { onWorkspaceLink } from './platform';

const inDesktopApp = () => Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  Object.assign(fake, { current: null, launchFile: null, urlListeners: [], fileListeners: [], unlistened: [] });
});

describe('onWorkspaceLink', () => {
  it('hands over the launch link and file, then each link and file from a later launch', async () => {
    inDesktopApp();
    fake.current = ['breakpatch://connect#c=first'];
    fake.launchFile = '{"name":"Launched"}';
    const got: string[] = [];
    const off = await onWorkspaceLink(p => got.push(p));
    expect(got).toEqual(['breakpatch://connect#c=first', '{"name":"Launched"}']);

    fake.urlListeners.forEach(cb => cb(['breakpatch://connect#c=second']));
    fake.fileListeners.forEach(cb => cb({ payload: '{"name":"Second launch"}' }));
    expect(got.slice(2)).toEqual(['breakpatch://connect#c=second', '{"name":"Second launch"}']);

    off();
    expect(fake.unlistened.sort()).toEqual(['file', 'url']);
  });

  it('listens for nothing in a browser', async () => {
    const cb = vi.fn();
    const off = await onWorkspaceLink(cb);
    off();
    expect(cb).not.toHaveBeenCalled();
    expect(fake.urlListeners).toHaveLength(0);
  });
});

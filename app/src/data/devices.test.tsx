// Phone and tablet tests (issue #11): the presets, the screen size picker, the live view's device
// frame, the add step bar's touch actions, the report's Device and the test file.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICES, deviceOf, deviceViewport, isTouch, screenName } from './devices';
import type { App, Viewport } from './types';
import { DemoBackend } from './demo/demoBackend';
import { useSession } from '../state/session';
import { ToastProvider } from '../components/ui';
import { getEngine } from '../engine';
import { NewTestDialog } from '../screens/app/NewTestDialog';
import RecorderScreen from '../screens/recorder/RecorderScreen';
import { SizePicker } from '../components/common';
import { LiveView } from '../components/live';
import { actionWords, touchWords } from '../engine/labels';
import { menuGroups, pageHint, shortName } from '../screens/recorder/actions';
import { ActionMenu } from '../screens/recorder/ActionMenu';
import { buildView } from '../lib/report/view';
import { initFolder } from './local/folder';
import { LocalBackend } from './local/localBackend';
import { fromFileText } from './local/format';
import { MemoryStorage } from './local/storage';

Element.prototype.scrollIntoView ??= () => undefined;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;   // not in jsdom
afterEach(cleanup);

const LAPTOP: Viewport = { width: 1440, height: 900, dpr: 1 };
const PHONE = deviceViewport(DEVICES[0]);

describe('presets', () => {
  it('lists phones first, then tablets, each stored by id with its size', () => {
    const kinds = DEVICES.map(d => d.kind);
    expect(kinds.indexOf('tablet')).toBeGreaterThan(kinds.lastIndexOf('phone'));
    expect(PHONE).toEqual({ width: 393, height: 659, dpr: 1, device: 'iphone-15' });
    expect(new Set(DEVICES.map(d => d.id)).size).toBe(DEVICES.length);
  });
  it('reads a viewport without a device as a desktop test', () => {
    expect(deviceOf(LAPTOP)).toBeUndefined();
    expect(isTouch(LAPTOP)).toBe(false);
    expect(screenName(LAPTOP)).toBe('1440 × 900');
    expect(deviceOf(PHONE)?.name).toBe('iPhone 15');
    expect(screenName(PHONE)).toBe('iPhone 15 · 393 × 659');
  });
  it("treats a device it doesn't know (a newer app's) as touch, and says so plainly", () => {
    const later = { width: 400, height: 800, dpr: 1 as const, device: 'phone-2030' };
    expect(isTouch(later)).toBe(true);
    expect(screenName(later)).toBe('Phone or tablet · 400 × 800');
  });
});

describe('touch words', () => {
  it('names the gestures for touch and leaves the rest', () => {
    expect(actionWords('click', true)).toEqual({ name: 'Tap', verb: 'Tap' });
    expect(actionWords('longClick', true).name).toBe('Long press');
    expect(actionWords('click', false).name).toBe('Click');
    expect(actionWords('swipe', true).name).toBe('Swipe');
    expect(touchWords('Click Sign in')).toBe('Tap Sign in');
    expect(touchWords('Double click here')).toBe('Double tap here');
    expect(touchWords('Long click the spot you clicked')).toBe('Long press the spot you tapped');
    expect(touchWords('Scroll down 300 px')).toBe('Scroll down 300 px');
  });
  it('drops Right click and Hover from a touch test\'s action list, and says why', () => {
    const names = (touch: boolean) => menuGroups({ allowGroups: true, touch }).flatMap(g => g.items.map(i => i.name));
    expect(names(false)).toEqual(expect.arrayContaining(['Click', 'Right click', 'Hover']));
    const touch = names(true);
    expect(touch).toEqual(expect.arrayContaining(['Tap', 'Double tap', 'Long press', 'Swipe', 'Scroll', 'Drag and drop', 'Write text']));
    expect(touch).not.toContain('Right click');
    expect(touch).not.toContain('Hover');
    expect(shortName('longClick', true)).toBe('Long press');
    expect(pageHint('click', true)).toBe('Click on the page to add a tap.');
    expect(pageHint('click')).toBe('Click on the page to add a step.');

    render(<ActionMenu open current="click" allowGroups touch onPick={() => undefined} onClose={() => undefined} />);
    expect(screen.getByRole('menuitemradio', { name: 'Tap' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Hover' })).toBeNull();
    expect(screen.getByText(/Right click and Hover need a mouse/)).toBeInTheDocument();
  });
});

describe('screen size picker', () => {
  it('offers computer sizes and the phones and tablets, and picks a device by its id', () => {
    const picked: Viewport[] = [];
    const { rerender } = render(<SizePicker value={LAPTOP} onChange={v => picked.push(v)} />);
    expect(screen.getByRole('radio', { name: /Laptop/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: /Pixel 8/ }));
    expect(picked).toEqual([{ width: 412, height: 839, dpr: 1, device: 'pixel-8' }]);
    rerender(<SizePicker value={picked[0]} onChange={v => picked.push(v)} />);
    expect(screen.getByRole('radio', { name: /Pixel 8/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Laptop/ })).toHaveAttribute('aria-checked', 'false');
    // A phone the same size as a computer choice would never light that one up.
    rerender(<SizePicker value={{ ...LAPTOP, device: 'ipad' }} onChange={() => undefined} />);
    expect(screen.getByRole('radio', { name: /Laptop/ })).toHaveAttribute('aria-checked', 'false');
  });
});

describe('live view', () => {
  it('shows a phone test in a device frame, named in the bar', () => {
    const { container } = render(<LiveView address="app.example.com" viewport={PHONE} readOnly source="sample" />);
    expect(screen.getByText('iPhone 15 · 393 × 659')).toBeInTheDocument();
    const frame = container.querySelector('.live-frame')!;
    expect(frame).toHaveClass('live-device', 'live-phone');
    expect((frame as HTMLElement).style.width).not.toBe('');
  });
  it('keeps a desktop test as before', () => {
    const { container } = render(<LiveView address="app.example.com" viewport={LAPTOP} readOnly source="sample" />);
    expect(screen.getByText('1440 × 900')).toBeInTheDocument();
    expect(container.querySelector('.live-frame')).not.toHaveClass('live-device');
  });
});

describe('report', () => {
  it('names the device a phone test ran as, and nothing for a desktop test', () => {
    const run = { id: 'r1', testName: 'Log in', testVersion: 1, startedBy: { uid: 'u', name: 'Ana', email: '' }, source: 'desktop' as const, machine: 'Mac', startedAt: 0, durationMs: 1000, result: 'pass' as const, healedCount: 0, steps: [] };
    const input = (device?: string) => ({ kind: 'run' as const, name: 'Log in', appVersion: '0.1.0', generatedAt: 0, tzOffsetMinutes: 0, screenshots: false,
      tests: [{ appName: 'Web app', name: 'Log in', steps: [], run, ...(device ? { device } : {}) }] });
    const meta = (device?: string) => buildView(input(device)).tests[0].meta;
    expect(meta('iPhone 15 · 393 × 659')).toContainEqual({ k: 'Device', v: 'iPhone 15 · 393 × 659' });
    expect(meta().map(m => m.k)).not.toContain('Device');
  });
});

describe('test files', () => {
  const ROOT = '/Users/ana/tests';
  const person = { uid: 'local', name: 'Ana', email: '' };
  it('keep a phone test\'s device, and read old files as desktop tests', async () => {
    const st = new MemoryStorage();
    await st.mkdir(ROOT);
    await initFolder(st, ROOT);
    const b = await LocalBackend.open({ storage: st, path: ROOT, person, live: false });
    try {
      const app = await b.addApp({ name: 'Web app', baseUrl: 'https://app.example.com', defaultViewport: LAPTOP });
      const phone = await b.createTest({ appId: app.id, name: 'Log in on a phone', startUrl: 'https://app.example.com', viewport: PHONE });
      const file = fromFileText<{ viewport: Viewport }>((await st.read(`${ROOT}/apps/${app.id}/tests/${phone.id}.json`))!);
      expect(file.viewport).toEqual(PHONE);
      st.poke(`${ROOT}/apps/${app.id}/tests/old.json`, JSON.stringify({ name: 'Old', version: 0, startUrl: 'https://app.example.com', viewport: { width: 1440, height: 900, dpr: 1 }, steps: [] }));
      await b.reload();
      const tests = await new Promise<{ id: string; viewport: Viewport }[]>(res => { const off = b.tests(app.id, v => { queueMicrotask(() => off()); res(v); }); });
      expect(tests.find(t => t.id === phone.id)?.viewport).toEqual(PHONE);
      const old = tests.find(t => t.id === 'old')!.viewport;
      expect(old.device).toBeUndefined();
      expect(isTouch(old)).toBe(false);
    } finally { b.close(); }
  });
});

describe('making and recording a phone test', () => {
  let backend: DemoBackend;
  let app: App;
  beforeEach(async () => {
    backend = new DemoBackend({ empty: true, signedIn: true, delayMs: 0 });
    useSession.setState({ backend });
    app = await backend.addApp({ name: 'Web', baseUrl: 'https://app.example.com', defaultViewport: LAPTOP });
  });
  afterEach(() => vi.restoreAllMocks());

  it('New test starts at the app\'s size and can be made for a phone', async () => {
    const made = vi.spyOn(backend, 'createTest');
    render(<ToastProvider><MemoryRouter><NewTestDialog open app={app} onClose={() => undefined} /></MemoryRouter></ToastProvider>);
    expect(screen.getByRole('radio', { name: /Laptop/ })).toHaveAttribute('aria-checked', 'true');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Log in on a phone' } });
    fireEvent.click(screen.getByRole('radio', { name: /iPhone 15/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start recording' }));
    await waitFor(() => expect(made).toHaveBeenCalled());
    expect(made.mock.calls[0][0].viewport).toEqual(PHONE);
  });

  it('the recorder opens the browser as the phone and offers touch actions', async () => {
    const t = await backend.createTest({ appId: app.id, name: 'Phone', startUrl: 'https://app.example.com', viewport: PHONE });
    const opened = vi.spyOn(getEngine(), 'openBrowser');
    const { container } = render(<ToastProvider><MemoryRouter initialEntries={[`/apps/${app.id}/tests/${t.id}/record`]}>
      <Routes><Route path="/apps/:appId/tests/:testId/record" element={<RecorderScreen />} /></Routes>
    </MemoryRouter></ToastProvider>);
    await waitFor(() => expect(opened).toHaveBeenCalled());
    expect(opened.mock.calls[0][1]).toEqual(PHONE);
    expect(await screen.findByText('iPhone 15 · 393 × 659')).toBeInTheDocument();
    expect(container.querySelector('.live-frame.live-device')).not.toBeNull();
    const actionBtn = container.querySelector('.rec-action-btn')!;
    expect(actionBtn).toHaveTextContent('Tap');
    fireEvent.click(actionBtn);
    expect(screen.getByRole('menuitemradio', { name: 'Long press' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitemradio', { name: 'Right click' })).toBeNull();
  });
});

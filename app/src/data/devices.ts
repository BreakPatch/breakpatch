// Phone and tablet presets (issue #11). The engine pins each one's user agent and touch screen
// (engine/src/breakpatch_engine/devices.py, from Playwright's device descriptors); this list is
// what the app shows and stores. engine/tests/test_devices.py keeps the two lists the same.
//
// A test names its preset in `viewport.device`, with the preset's size in width and height. A
// test without one is a desktop test, as every test made before presets existed.
import type { Viewport } from './types';

export interface Device {
  /** Stored in the test file: `viewport.device`. Never renamed. */
  id: string;
  name: string;
  kind: 'phone' | 'tablet';
  width: number;
  height: number;
}

/** Phones first, then tablets. */
export const DEVICES: Device[] = [
  { id: 'iphone-15', name: 'iPhone 15', kind: 'phone', width: 393, height: 659 },
  { id: 'iphone-se', name: 'iPhone SE', kind: 'phone', width: 375, height: 667 },
  { id: 'pixel-8', name: 'Pixel 8', kind: 'phone', width: 412, height: 839 },
  { id: 'galaxy-s24', name: 'Galaxy S24', kind: 'phone', width: 360, height: 780 },
  { id: 'ipad', name: 'iPad', kind: 'tablet', width: 810, height: 1080 },
  { id: 'ipad-pro-11', name: 'iPad Pro 11', kind: 'tablet', width: 834, height: 1194 },
  { id: 'galaxy-tab-s9', name: 'Galaxy Tab S9', kind: 'tablet', width: 640, height: 1024 },
];

const BY_ID = new Map(DEVICES.map(d => [d.id, d]));

/** The viewport a test made for this device stores. */
export const deviceViewport = (d: Device): Viewport => ({ width: d.width, height: d.height, dpr: 1, device: d.id });

/** The preset a viewport names, or undefined for a desktop test (or a device from a newer app). */
export function deviceOf(v: Pick<Viewport, 'device'> | undefined | null): Device | undefined {
  return v?.device ? BY_ID.get(v.device) : undefined;
}

/**
 * Whether a test's page is a touch screen: steps are taps, presses and swipes. Any device counts,
 * one this app doesn't know too (from a newer app), so hover-only steps are never offered for it.
 */
export function isTouch(v: Pick<Viewport, 'device'> | undefined | null): boolean {
  return !!v?.device;
}

/** "iPhone 15 · 393 × 659", or "1440 × 900" for a desktop test. */
export function screenName(v: Pick<Viewport, 'width' | 'height' | 'device'>): string {
  const size = `${v.width} × ${v.height}`;
  if (!v.device) return size;
  return `${deviceOf(v)?.name ?? 'Phone or tablet'} · ${size}`;
}

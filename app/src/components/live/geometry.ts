// Pure geometry for the live view. Everything stored is in viewport pixels at DPR 1
// (engine/PROTOCOL.md); the view only scales for display.
import type { Box, Point, Step, Viewport } from '../../data/types';

export const PAGE_PAD = 16;
export const ZOOMS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5];

/** Scale that fits the viewport inside the pane (minus padding), never above 1. */
export function fitScale(pane: { width: number; height: number }, vp: Pick<Viewport, 'width' | 'height'>, pad = PAGE_PAD): number {
  const w = Math.max(1, pane.width - pad * 2), h = Math.max(1, pane.height - pad * 2);
  return Math.max(0.05, Math.min(1, w / vp.width, h / vp.height));
}

export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOMS.find(z => z > current + 0.005) ?? ZOOMS[ZOOMS.length - 1];
  return [...ZOOMS].reverse().find(z => z < current - 0.005) ?? ZOOMS[0];
}

/** Display offset inside the page element → viewport pixels, clamped to the page. */
export function toViewport(offset: { x: number; y: number }, scale: number, vp: Pick<Viewport, 'width' | 'height'>): Point {
  const x = Math.round(offset.x / scale), y = Math.round(offset.y / scale);
  return [Math.max(0, Math.min(vp.width - 1, x)), Math.max(0, Math.min(vp.height - 1, y))];
}

export function normBox(a: Point, b: Point): Box {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export const center = (b: Box): Point => [Math.round((b[0] + b[2]) / 2), Math.round((b[1] + b[3]) / 2)];
export const around = (p: Point, rx: number, ry = rx): Box => [p[0] - rx, p[1] - ry, p[0] + rx, p[1] + ry];
export const distance = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const inside = (p: Point, b: Box) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];

/** Direction and distance of a swipe or scroll gesture from a drag on the page. */
export function gesture(from: Point, to: Point): { direction: 'up' | 'down' | 'left' | 'right'; distance: number } {
  const dx = to[0] - from[0], dy = to[1] - from[1];
  if (Math.abs(dx) > Math.abs(dy)) return { direction: dx > 0 ? 'right' : 'left', distance: Math.round(Math.abs(dx)) };
  return { direction: dy > 0 ? 'down' : 'up', distance: Math.round(Math.abs(dy)) };
}

/**
 * The area a step is locked to, the one marker the recorder draws: the checked region for
 * checkpoints and waits, else the pre-check region, else a small box around the point.
 * `targetBox` (demo) snaps a point to the known button under it.
 */
export function lockBox(step: Step, targetBox?: (p: Point) => Box | undefined): Box | null {
  if ((step.action === 'checkpoint' || step.action === 'waitUntil') && step.region) return step.region;
  const at = step.at ?? step.from;
  if (at && targetBox) { const b = targetBox(at); if (b) return b; }
  if (step.pre?.region) return step.pre.region;
  return at ? around(at, 24) : null;
}

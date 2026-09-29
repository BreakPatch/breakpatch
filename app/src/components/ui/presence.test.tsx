// DES-01: menus and dialogs leave the way they came (kept on screen while .closing plays), and
// reopening while one leaves turns it back. DES-10: destructive confirms start on Cancel.
// DES-14: the chip select is the app's own menu, keyboard and all.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Button, ChipSelect, Dialog, Menu } from '.';
import { EXIT_MS, useLatched, usePresence } from './presence';

const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const fs = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const here = dirname(fileURLToPath(import.meta.url));
const css = (p: string) => fs.readFileSync(join(here, p), 'utf8');

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const items = [{ label: 'Edit', onSelect: () => undefined }, { label: 'Delete', danger: true, onSelect: () => undefined }];
const menu = (open: boolean) => <Menu open={open} onClose={() => undefined} items={items} label="More" />;

describe('usePresence', () => {
  it('stays mounted while closing, then unmounts; reopening mid-exit clears closing', () => {
    const { result, rerender } = renderHook(({ open }) => usePresence(open), { initialProps: { open: true } });
    expect(result.current).toEqual({ mounted: true, closing: false });
    rerender({ open: false });
    expect(result.current).toEqual({ mounted: true, closing: true });
    act(() => { vi.advanceTimersByTime(EXIT_MS - 20); });
    rerender({ open: true });
    expect(result.current).toEqual({ mounted: true, closing: false });
    act(() => { vi.advanceTimersByTime(EXIT_MS * 2); });
    expect(result.current.mounted).toBe(true);
    rerender({ open: false });
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(result.current).toEqual({ mounted: false, closing: false });
  });

  it('latches the last value without looping on fresh objects', () => {
    const same = (a: { t: string }, b: { t: string }) => a.t === b.t;
    const { result, rerender } = renderHook(({ v }) => useLatched(v, same), { initialProps: { v: { t: 'a' } as { t: string } | null } });
    rerender({ v: { t: 'a' } });
    rerender({ v: { t: 'b' } });
    rerender({ v: null });
    expect(result.current).toEqual({ t: 'b' });
  });
});

describe('Menu and Dialog ways out', () => {
  it('keeps a closing menu on screen, hidden from the keyboard and screen readers, then removes it', () => {
    const { container, rerender } = render(menu(true));
    const el = container.querySelector('.menu')!;
    rerender(menu(false));
    expect(container.querySelector('.menu')).toBe(el);
    expect(el).toHaveClass('closing');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('menu')).toBeNull();
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(container.querySelector('.menu')).toBeNull();
  });

  it('turns back when reopened while leaving: the same element, no longer closing', () => {
    const { container, rerender } = render(menu(true));
    const el = container.querySelector('.menu')!;
    rerender(menu(false));
    act(() => { vi.advanceTimersByTime(60); });
    rerender(menu(true));
    expect(container.querySelector('.menu')).toBe(el);
    expect(el).not.toHaveClass('closing');
    act(() => { vi.advanceTimersByTime(EXIT_MS * 2); });
    expect(container.querySelector('.menu')).toBe(el);
  });

  it('fades a dialog and its scrim out, and a destructive confirm starts on Cancel', () => {
    const d = (open: boolean) => (
      <Dialog open={open} onClose={() => undefined} title="Delete this suite?"
        actions={<><Button data-autofocus>Cancel</Button><Button kind="danger">Delete suite</Button></>} />
    );
    const { rerender } = render(d(true));
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    rerender(d(false));
    expect(document.querySelector('.scrim.closing .dialog.closing')).not.toBeNull();
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(document.querySelector('.scrim')).toBeNull();
  });

  it('plays the exit backwards from where the entrance ends, and only fades under Reduce motion', () => {
    const global = css('../../styles/global.css'), ui = css('ui.css');
    expect(global).toMatch(/\.closing \{\s*opacity: 0; transform: scale\(\.96\);[^}]*transition: opacity 130ms cubic-bezier\(\.4,0,1,1\)/);
    // Filling "both" would pin opacity at 1 over the exit transition.
    expect(ui).toMatch(/\.menu \{[^}]*animation: bpPop 150ms ease-out backwards/);
    expect(ui).toMatch(/\.dialog \{[^}]*animation: bpPop 170ms ease-out backwards/);
    // DES-03: Reduce motion no longer switches everything off: entrances fade, spinners pulse.
    const reduce = global.slice(global.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(global).not.toMatch(/animation: none !important/);
    expect(reduce).toMatch(/@keyframes bpPop \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
    expect(reduce).toMatch(/@keyframes bpIn \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/);
    expect(reduce).toMatch(/\.spin, \.anim-spin \{ animation: bpPulse 1\.4s/);
    expect(reduce).toMatch(/transition-duration: 150ms/);
    expect(reduce).toMatch(/\.closing \{ transform: none/);
  });
});

describe('ChipSelect', () => {
  function Pick() {
    const [v, setV] = useState<'a' | 'b' | 'c'>('a');
    return <><label htmlFor="c">What should happen</label>
      <ChipSelect id="c" value={v} onChange={setV} options={[{ value: 'a', label: 'As recorded' }, { value: 'b', label: 'Something appears' }, { value: 'c', label: 'Nothing visible changes' }]} /></>;
  }
  it('opens the app menu from the chip, ticks the choice, moves with the arrows and picks with Enter', () => {
    render(<Pick />);
    const chip = screen.getByLabelText('What should happen');
    expect(chip).toHaveAttribute('aria-haspopup', 'menu');
    fireEvent.keyDown(chip, { key: 'ArrowDown' });
    expect(screen.getByRole('menu').style.transformOrigin).toBe('top left');
    const ticked = screen.getByRole('menuitemradio', { name: 'As recorded' });
    expect(ticked).toHaveAttribute('aria-checked', 'true');
    expect(ticked).toHaveFocus();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    expect(screen.getByRole('menuitemradio', { name: 'Something appears' })).toHaveFocus();
    fireEvent.click(document.activeElement!);
    expect(chip).toHaveTextContent('Something appears');
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(screen.queryByRole('menu')).toBeNull();
  });
  it('opens upward from a chip near the bottom', () => {
    render(<ChipSelect up label="Generated value" value="x" onChange={() => undefined} options={[{ value: 'x', label: 'A unique name' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Generated value: A unique name' }));
    expect(screen.getByRole('menu').style.transformOrigin).toBe('bottom left');
  });
});

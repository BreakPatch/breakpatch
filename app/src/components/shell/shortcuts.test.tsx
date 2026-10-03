// The shortcuts in the app window (AppFrame: ⌘ on a Mac, Ctrl on Windows and Linux) and how menus
// open and close (ui Menu).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ariaShortcut, setOsForTests } from '../../lib/osWords';
import { Button, Menu } from '../ui';
import { AppFrame } from './AppFrame';

// The same whichever edition this checkout builds (the Team module may be linked in).
vi.mock('../../edition', () => ({ edition: { name: 'community', nav: [], slots: {}, settings: [], routes: [], gate: { paths: [] } } }));

afterEach(() => { cleanup(); setOsForTests(null); });

function Where() { return <div data-testid="where">{useLocation().pathname}</div>; }

function Screen({ onNew = () => {} }: { onNew?: () => void }) {
  return (
    <AppFrame nav="apps" actions={<Button kind="primary" aria-keyshortcuts={ariaShortcut('N')} onClick={onNew}>New test</Button>}>
      <div className="cm-search"><input aria-label="Search tests" /></div>
      <Where />
    </AppFrame>
  );
}
const at = (el: React.ReactNode) => render(
  <MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={el} /><Route path="/settings" element={<Where />} /></Routes></MemoryRouter>,
);

describe('Mac shortcuts', () => {
  it('⌘, opens Settings', () => {
    at(<Screen />);
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(screen.getByTestId('where')).toHaveTextContent('/settings');
  });

  it('⌘N presses the screen\'s new button and ⌘F goes to its search box', () => {
    const onNew = vi.fn();
    at(<Screen onNew={onNew} />);
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    expect(onNew).toHaveBeenCalledOnce();
    fireEvent.keyDown(window, { key: 'f', metaKey: true });
    expect(screen.getByLabelText('Search tests')).toHaveFocus();
  });

  it('does nothing without ⌘ or while a dialog is open', () => {
    const onNew = vi.fn();
    at(<><Screen onNew={onNew} /><div role="dialog" aria-modal="true" /></>);
    fireEvent.keyDown(window, { key: 'n', metaKey: true });
    fireEvent.keyDown(window, { key: ',', metaKey: true });
    expect(onNew).not.toHaveBeenCalled();
    expect(screen.getByTestId('where')).toHaveTextContent('/');
  });
});

describe('Ctrl shortcuts on Windows and Linux', () => {
  for (const os of ['windows', 'linux'] as const) {
    it(`Ctrl+, Ctrl+N and Ctrl+F work on ${os}, and ⌘ does nothing there`, () => {
      setOsForTests(os);
      const onNew = vi.fn();
      at(<Screen onNew={onNew} />);
      expect(screen.getByRole('button', { name: 'New test' })).toHaveAttribute('aria-keyshortcuts', 'Control+N');
      fireEvent.keyDown(window, { key: 'n', metaKey: true });
      expect(onNew).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
      expect(onNew).toHaveBeenCalledOnce();
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true });
      expect(screen.getByLabelText('Search tests')).toHaveFocus();
      fireEvent.keyDown(window, { key: ',', ctrlKey: true });
      expect(screen.getByTestId('where')).toHaveTextContent('/settings');
    });
  }

  it('on a Mac, Ctrl alone is not the shortcut key', () => {
    const onNew = vi.fn();
    at(<Screen onNew={onNew} />);
    fireEvent.keyDown(window, { key: 'n', ctrlKey: true });
    expect(onNew).not.toHaveBeenCalled();
  });
});

function MenuHost({ style }: { style: React.CSSProperties }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen(true)}>More</button>
      <Menu open={open} onClose={() => setOpen(false)} label="Actions" style={style} items={[{ label: 'Rename', onSelect: () => {} }]} />
    </div>
  );
}

describe('Menu', () => {
  it('grows from the corner nearest its trigger', () => {
    render(<MenuHost style={{ top: '100%', right: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menu').style.transformOrigin).toBe('top right');
    cleanup();
    render(<MenuHost style={{ bottom: '100%', left: 0 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('menu').style.transformOrigin).toBe('bottom left');
  });

  it('gives focus back to its button when closed with Escape', async () => {
    render(<MenuHost style={{ top: '100%', left: 0 }} />);
    const more = screen.getByRole('button', { name: 'More' });
    more.focus();
    fireEvent.click(more);
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus();
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }); });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(more).toHaveFocus();
  });
});

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSession } from '../../../state/session';
import { ALLOW_DIFFERENCES, ScreenChecksSection } from './ScreenChecksSection';

afterEach(() => { cleanup(); useSession.getState().setPrefs({ allowSystemDifferences: true }); });

describe('Settings → Screen checks', () => {
  it('allows for small differences between systems by default, and can be turned off', () => {
    expect(useSession.getState().prefs.allowSystemDifferences).toBe(true);
    render(<ScreenChecksSection />);
    const toggle = screen.getByRole('switch', { name: ALLOW_DIFFERENCES });
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(toggle);
    expect(useSession.getState().prefs.allowSystemDifferences).toBe(false);
    expect(JSON.parse(localStorage.getItem('breakpatch.session.v1')!).prefs.allowSystemDifferences).toBe(false);
    expect(screen.getByText(/recorded and run on the same kind of machine/)).toBeTruthy();
  });
});

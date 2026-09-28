import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useSession } from '../../../state/session';
import { NotificationsSection } from './NotificationsSection';

afterEach(cleanup);

describe('Settings → Notifications', () => {
  it('has Failures on and Every finished run off by default, and keeps a change', () => {
    useSession.getState().setPrefs({ notifyFailures: undefined, notifyAll: undefined });
    render(<NotificationsSection />);
    const failures = screen.getByRole('switch', { name: 'Failures' });
    const all = screen.getByRole('switch', { name: 'Every finished run' });
    expect(failures).toBeChecked();
    expect(all).not.toBeChecked();
    fireEvent.click(all);
    expect(useSession.getState().prefs.notifyAll).toBe(true);
    expect(screen.getByText(/Schedules and the local runner use these settings too/)).toBeInTheDocument();
  });
});

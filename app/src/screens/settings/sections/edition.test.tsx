import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { edition } from '../../../edition';
import { EditionMismatch, editionLabel, editionMismatch } from './edition';

afterEach(cleanup);

describe('edition in Settings → About', () => {
  it('names the editions', () => {
    expect(editionLabel('community')).toBe('Community');
    expect(editionLabel('team')).toBe('Team');
  });

  it('is quiet when the engine agrees or has not answered', () => {
    expect(editionMismatch('community', 'community')).toBeNull();
    expect(editionMismatch('team', 'team')).toBeNull();
    expect(editionMismatch('team', undefined)).toBeNull();
  });

  it('warns about a Team app with a Community engine', () => {
    expect(editionMismatch('team', 'community')).toMatch(/Community engine.*can’t be fixed automatically/);
    render(<EditionMismatch app="team" engine="community" />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('app Team, engine Community');
  });

  it('warns about a Community app with a Team engine', () => {
    render(<EditionMismatch app="community" engine="team" />);
    expect(screen.getByRole('alert').textContent).toContain('app Community, engine Team');
  });

  it('renders nothing when they match', () => {
    const { container } = render(<EditionMismatch app="community" engine="community" />);
    expect(container.innerHTML).toBe('');
  });

  it('the app edition is Team exactly when the Team module is linked', () => {
    const linked = Object.keys(import.meta.glob('../../../edition/team/index.ts')).length > 0;
    expect(edition.name).toBe(linked ? 'team' : 'community');
  });
});

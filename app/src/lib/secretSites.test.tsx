import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secrets } from '../platform';
import { SecretSitesPrompt } from '../components/shell/SecretSitesPrompt';
import { ensureSecretSites, forgetAskedForTests, useSitesQuestion } from './secretSites';

async function siteOf(name: string) { return (await secrets.info()).find(s => s.name === name)?.origins; }

beforeEach(async () => {
  forgetAskedForTests();
  // Saved before secrets had sites: no origins.
  await secrets.set('OLD_PASSWORD', 'pw');
  await secrets.setPolicy('OLD_PASSWORD', [], false);
  await secrets.set('OLD_EMAIL', 'qa@x.dev');
  await secrets.setPolicy('OLD_EMAIL', [], false);
});
afterEach(async () => { cleanup(); await secrets.remove('OLD_PASSWORD'); await secrets.remove('OLD_EMAIL'); });

describe('secrets saved before sites existed', () => {
  it('asks once, for all of them, to allow the app’s site', async () => {
    render(<SecretSitesPrompt />);
    const done = ensureSecretSites(['OLD_PASSWORD', 'OLD_EMAIL', 'ACME_TEST_EMAIL'], 'https://app.acme.com/login');
    await screen.findByText(/Allow these saved secrets on app\.acme\.com\?/);
    expect(screen.getByText('OLD_EMAIL, OLD_PASSWORD')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Allow on app.acme.com' }));
    await act(() => done);
    expect(await siteOf('OLD_PASSWORD')).toEqual(['https://app.acme.com']);
    expect(await siteOf('OLD_EMAIL')).toEqual(['https://app.acme.com']);
    expect(await siteOf('ACME_TEST_EMAIL')).toEqual(['https://app.example.com']);   // it had one: left alone
    expect(useSitesQuestion.getState().question).toBeNull();
  });

  it('remembers "Not now" and doesn’t ask again', async () => {
    render(<SecretSitesPrompt />);
    const done = ensureSecretSites(['OLD_PASSWORD'], 'https://app.acme.com');
    await screen.findByText(/Allow this saved secret on app\.acme\.com\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    await act(() => done);
    expect(await siteOf('OLD_PASSWORD')).toEqual([]);
    await ensureSecretSites(['OLD_PASSWORD'], 'https://app.acme.com');      // resolves without a question
    expect(useSitesQuestion.getState().question).toBeNull();
  });

  it('asks nothing without such secrets or an app address', async () => {
    await ensureSecretSites(['ACME_TEST_EMAIL', 'NOT_ON_THIS_MAC'], 'https://app.acme.com');
    await ensureSecretSites(['OLD_PASSWORD'], 'not an address');
    await ensureSecretSites([], 'https://app.acme.com');
    expect(useSitesQuestion.getState().question).toBeNull();
  });
});

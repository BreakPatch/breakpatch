import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { hasFeature, lockFeatures, resetFeaturesForTests, setFeatures, useFeature, useFeatureStore } from './features';
import { NO_FEATURES } from './types';

const ALL_ON = Object.fromEntries(Object.keys(NO_FEATURES).map(k => [k, true])) as unknown as typeof NO_FEATURES;

function Probe() {
  return <span>{useFeature('versions') ? 'history on' : 'history off'}</span>;
}

describe('the features store', () => {
  afterEach(() => resetFeaturesForTests());

  it('starts with everything off', () => {
    expect(useFeatureStore.getState().features).toEqual(NO_FEATURES);
    expect(hasFeature('collaboration')).toBe(false);
  });

  it('changes at runtime and re-renders components that use a feature', () => {
    render(<Probe />);
    expect(screen.getByText('history off')).toBeInTheDocument();
    act(() => setFeatures({ ...NO_FEATURES, versions: true }));
    expect(screen.getByText('history on')).toBeInTheDocument();
    expect(hasFeature('versions')).toBe(true);
    expect(hasFeature('runner')).toBe(false);
    act(() => setFeatures(NO_FEATURES));
    expect(screen.getByText('history off')).toBeInTheDocument();
  });

  it('keeps the same object when nothing changed', () => {
    setFeatures(ALL_ON);
    const before = useFeatureStore.getState().features;
    setFeatures({ ...ALL_ON });
    expect(useFeatureStore.getState().features).toBe(before);
  });

  it('stays off once locked, as Community does', () => {
    lockFeatures();
    setFeatures(ALL_ON);
    expect(useFeatureStore.getState().features).toEqual(NO_FEATURES);
  });
});

describe('the Community edition', () => {
  it('has every feature off and locked', async () => {
    const { edition } = await import('./index');
    if (edition.name !== 'community') return; // the Team module is linked; its own tests cover it
    setFeatures(ALL_ON);                         // edition/index.ts locked them at start
    expect(hasFeature('collaboration')).toBe(false);
  });
});

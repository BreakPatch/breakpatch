// What the edition unlocks right now. Community: everything off, for good. Team: its Provider
// sets them at runtime from the licence (the token's features while it's active or in grace, all
// off otherwise), so they can change while the app runs.
//
// Read them with `useFeature(f)` in components that must update when they change, or
// `hasFeature(f)` in code that runs at a moment (starting a run, saving).
import { create } from 'zustand';
import { NO_FEATURES, type Features } from './types';

interface FeatureState { features: Features }

export const useFeatureStore = create<FeatureState>(() => ({ features: NO_FEATURES }));

let locked = false;

/** Replaces the features (Team: from the licence). Ignored once they're locked (Community). */
export function setFeatures(f: Features): void {
  if (locked) return;
  const cur = useFeatureStore.getState().features;
  if ((Object.keys(f) as (keyof Features)[]).every(k => cur[k] === f[k]) && Object.keys(cur).length === Object.keys(f).length) return;
  useFeatureStore.setState({ features: { ...f } });
}

/** Fixes the features where they are; the Community edition does this at start. */
export function lockFeatures(): void { locked = true; }

export function hasFeature(f: keyof Features): boolean { return useFeatureStore.getState().features[f]; }

/** The feature, re-rendering the component when it changes. */
export function useFeature(f: keyof Features): boolean { return useFeatureStore(s => s.features[f]); }

/** For tests only. */
export function resetFeaturesForTests(): void { locked = false; useFeatureStore.setState({ features: NO_FEATURES }); }

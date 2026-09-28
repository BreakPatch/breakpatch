// Picks the edition at build time. When the private Team module is linked at
// ./team (scripts/link-team.sh), the glob finds it; otherwise it's empty and the
// app is Community.
import community from './community';
import { lockFeatures, setFeatures } from './features';
import type { Edition } from './types';

const found = import.meta.glob<{ default: Edition }>('./team/index.ts', { eager: true });

export const edition: Edition = found['./team/index.ts']?.default ?? community;

// The features to start with (features.ts). Community's stay off for good; the Team Provider
// changes them at runtime from the licence.
setFeatures(edition.features);
if (edition.name === 'community') lockFeatures();

export { hasFeature, useFeature } from './features';
export type { Edition, Features, ReportFixProps, SettingsSection, SuiteEditorPanelProps, SuiteExtras } from './types';

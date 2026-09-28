import { NO_FEATURES, type Edition } from './types';

/** The open-source edition: one person, one Mac, tests as local files. */
const community: Edition = {
  name: 'community',
  features: NO_FEATURES,
  routes: [],
  settings: [],
  nav: [],
  slots: {},
  // No sign-in: one person on one Mac. Until a tests folder is chosen, the app starts at
  // Welcome; the demo workspace opens only with `?demo` (session.ts).
  gate: { check: s => ((!s.local && !s.workspace) || !s.user ? '/welcome' : null), paths: ['/welcome'] },
};

export default community;

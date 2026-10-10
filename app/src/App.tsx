// Routes and the first-launch gate: the edition's own steps (Team: connect a workspace →
// sign in; Community: the welcome screen) → setup → the app.
import { lazy, Suspense, useEffect, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ToastProvider } from './components/ui';
import { ErrorDialog } from './components/shell/ErrorDialog';
import { UsageNotice } from './components/shell/UsageNotice';
import { EngineStarting } from './components/shell/EngineStarting';
import { NotificationReturn } from './components/shell/NotificationReturn';
import { OpenLinks } from './components/shell/OpenLinks';
import { getEngine } from './engine';
import { SecretSitesPrompt } from './components/shell/SecretSitesPrompt';
import { useSession } from './state/session';
import { useApplyTheme } from './state/theme';
import { edition } from './edition';

const WelcomeScreen = lazy(() => import('./screens/welcome/WelcomeScreen'));
const SetupScreen = lazy(() => import('./screens/setup/SetupScreen'));
const HomeScreen = lazy(() => import('./screens/home/HomeScreen'));
const AppScreen = lazy(() => import('./screens/app/AppScreen'));
const RecorderScreen = lazy(() => import('./screens/recorder/RecorderScreen'));
const SharedStepsEditorScreen = lazy(() => import('./screens/recorder/SharedStepsEditorScreen'));
const RunScreen = lazy(() => import('./screens/run/RunScreen'));
const ReportScreen = lazy(() => import('./screens/report/ReportScreen'));
const SettingsScreen = lazy(() => import('./screens/settings/SettingsScreen'));
const SuitesScreen = lazy(() => import('./screens/suites/SuitesScreen'));
const SuiteEditorScreen = lazy(() => import('./screens/suites/SuiteEditorScreen'));
const SuiteRunScreen = lazy(() => import('./screens/suites/SuiteRunScreen'));

/**
 * Route map (hash router, so deep links survive reloads in the webview):
 *   /welcome                               Community first launch: choose a tests folder
 *   /setup                                 first launch
 *   /                                      Home: apps
 *   /apps/:appId?tab=tests|shared|runs     App
 *   /apps/:appId/tests/:testId/record      Recorder (?step=<id> opens on a step, ?rerecord=<id>)
 *   /apps/:appId/tests/:testId/run         Run view (live)
 *   /apps/:appId/run-all                   Run every test of the app, like a suite (SuiteRunScreen)
 *   /apps/:appId/runs/:runId               Run report (?tab=history)
 *   /apps/:appId/shared/:groupId/edit      Shared steps editor
 *   /suites, /suites/new, /suites/:suiteId Suites and suite editor
 *   /suites/:suiteId/run                  Run a suite by hand on this Mac
 *   /settings/:section                     ai|secrets|appearance|privacy|about, plus the edition's sections
 * The edition adds its own (Team: /connect, /signin, /runner, /runner-mode, version history).
 * breakpatch://open links (lib/openLinks.ts) open a test's recorder or a suite in its workspace.
 */
export default function App() {
  useEffect(() => { getEngine(); }, []);        // starts asking the engine at once ("Starting Breakpatch…")
  useApplyTheme();
  useOnlineStatus();
  const Provider = edition.Provider ?? Passthrough;
  return (
    <ToastProvider>
      <Provider>
        <HashRouter>
          <Suspense fallback={<div className="window" />}>
            <Gate>
              <Routes>
                <Route path="/welcome" element={<WelcomeScreen />} />
                <Route path="/setup" element={<SetupScreen />} />
                <Route path="/" element={<HomeScreen />} />
                <Route path="/apps/:appId" element={<AppScreen />} />
                <Route path="/apps/:appId/tests/:testId/record" element={<RecorderScreen />} />
                <Route path="/apps/:appId/tests/:testId/run" element={<RunScreen />} />
                <Route path="/apps/:appId/run-all" element={<SuiteRunScreen />} />
                <Route path="/apps/:appId/runs/:runId" element={<ReportScreen />} />
                <Route path="/apps/:appId/shared/:groupId/edit" element={<SharedStepsEditorScreen />} />
                <Route path="/suites" element={<SuitesScreen />} />
                <Route path="/suites/new" element={<SuiteEditorScreen />} />
                <Route path="/suites/:suiteId" element={<SuiteEditorScreen />} />
                <Route path="/suites/:suiteId/run" element={<SuiteRunScreen />} />
                <Route path="/settings" element={<SettingsScreen />} />
                <Route path="/settings/:section" element={<SettingsScreen />} />
                {edition.routes.map(r => <Route key={r.path} path={r.path} element={<r.element />} />)}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Gate>
          </Suspense>
          <ErrorDialog />
          <SecretSitesPrompt />
          <UsageNotice />
          <EngineStarting />
          <NotificationReturn />
          <OpenLinks />
        </HashRouter>
      </Provider>
    </ToastProvider>
  );
}

function Passthrough({ children }: { children: ReactNode }) { return <>{children}</>; }

/** Nothing else opens until the edition's first-launch steps and setup are done. */
function Gate({ children }: { children: ReactNode }) {
  const { workspace, local, user, setupDone, pendingWorkspace } = useSession();
  const { pathname } = useLocation();
  const target = edition.gate.check({ workspace, local, user, pendingWorkspace }, pathname) ?? (!setupDone ? '/setup' : null);
  if (target && pathname !== target) return <Navigate to={target} replace />;
  if (!target && [...edition.gate.paths, '/setup'].includes(pathname)) return <Navigate to={edition.startPath?.() ?? '/'} replace />;
  return <>{children}</>;
}

function useOnlineStatus() {
  useEffect(() => {
    const on = () => useSession.getState().setOnline(true);
    const offl = () => useSession.getState().setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', offl);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', offl); };
  }, []);
}

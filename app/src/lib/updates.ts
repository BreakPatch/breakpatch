// Auto-update through the Tauri updater (spec §17). Endpoint and public key live in tauri.conf.json.
import { isTauri } from '../platform';
import { useSystem } from '../state/system';

type Pending = { version: string; install: () => Promise<void> };
let pending: Pending | null = null;

export type CheckResult = { state: 'upToDate' } | { state: 'ready'; version: string } | { state: 'failed'; reason: string };

/** Checks GitHub Releases for a newer version and downloads it in the background. */
export async function checkForUpdates(): Promise<CheckResult> {
  if (!isTauri()) {
    await new Promise(r => setTimeout(r, 1200));
    return { state: 'upToDate' };
  }
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return { state: 'upToDate' };
    await update.download();                        // signature is verified by the plugin
    pending = { version: update.version, install: () => update.install() };
    useSystem.getState().setUpdateReady(update.version);
    return { state: 'ready', version: update.version };
  } catch (e) {
    return { state: 'failed', reason: "Couldn't reach GitHub to check for updates." + (e instanceof Error ? ` (${e.message})` : '') };
  }
}

export async function restartToUpdate(): Promise<void> {
  if (!pending) return;
  await pending.install();
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}

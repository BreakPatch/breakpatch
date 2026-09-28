import { describe, expect, it } from 'vitest';
import tauriConf from '../../src-tauri/tauri.conf.json?raw';
import { APP_DATA_FOLDER, MODELS_DIR } from './paths';

// The engine lives outside the app root, which Vite won't import from, so read it from disk.
// (Node modules are untyped in the app's tsconfig.)
const fsModule = 'node:fs', urlModule = 'node:url', pathModule = 'node:path';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: string, enc: 'utf8'): string };
const { fileURLToPath } = (await import(/* @vite-ignore */ urlModule)) as { fileURLToPath(url: string): string };
const { dirname, join } = (await import(/* @vite-ignore */ pathModule)) as { dirname(p: string): string; join(...p: string[]): string };
const engineConfig = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../../engine/src/breakpatch_engine/config.py'), 'utf8');

// A rename of the product must not rename this folder by accident: the model (about 3 GB) lives
// there and every user would have to download it again. Change these on purpose or not at all.
describe('app data folder', () => {
  it('keeps the model in Application Support/Breakpatch/models', () => {
    expect(APP_DATA_FOLDER).toBe('Breakpatch');
    expect(MODELS_DIR).toBe('~/Library/Application Support/Breakpatch/models');
  });

  it('holds the screenshots folder, the only one the Tauri asset scope allows', () => {
    const scope: string[] = JSON.parse(tauriConf).app.security.assetProtocol.scope;
    expect(scope).toEqual([`$DATA/${APP_DATA_FOLDER}/screenshots/**`]);
    expect(engineConfig).toContain('app_home() / "screenshots"');
  });

  it('is the folder the engine uses', () => {
    expect(engineConfig).toContain(`/ "Application Support" / "${APP_DATA_FOLDER}"`);
  });
});

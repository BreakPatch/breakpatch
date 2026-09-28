/**
 * The app's data folder under ~/Library/Application Support. The engine
 * (engine/src/breakpatch_engine/config.py) keeps the AI model, browser and screenshots there, and
 * src-tauri/tauri.conf.json lets the UI read its screenshots folder (only that one). Renaming it moves the model (about 3 GB), so
 * everyone downloads it again: paths.test.ts pins it.
 */
export const APP_DATA_FOLDER = 'Breakpatch';
export const MODELS_DIR = `~/Library/Application Support/${APP_DATA_FOLDER}/models`;

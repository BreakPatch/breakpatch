// lib/ is below the screens: the shared report view and the words it shares with breakpatch-ci
// (runWords.ts) must work without them (the Team module's runner builds reports with lib/report).
import { describe, expect, it } from 'vitest';

const SOURCES = import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

describe('lib/', () => {
  it('imports nothing from screens/ or components/', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(10);
    const up = Object.entries(SOURCES).flatMap(([f, src]) =>
      [...src.matchAll(/^\s*(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]!).filter(p => /(^|\/)(screens|components)\//.test(p)).map(p => `${f}: ${p}`));
    expect(up).toEqual([]);
  });
});

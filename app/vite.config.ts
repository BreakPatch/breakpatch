import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'
import type { Plugin, Rollup } from 'vite'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

// The Team module is linked at src/edition/team for a Team build (scripts/link-team.sh); the app
// builds as Community without it (src/edition/index.ts). The release build hardens the Team output
// only (src-tauri/README.md "Hardening"); Community stays plain minified, it's open source anyway.
// BP_EDITION (set by scripts/build-release.sh) wins; otherwise the link decides.
const teamLinked = existsSync(fileURLToPath(new URL('./src/edition/team/index.ts', import.meta.url)))
const isTeam = (process.env.BP_EDITION || (teamLinked ? 'team' : 'community')) === 'team'
// Obfuscation is opt-in (BP_OBFUSCATE=1): it needs javascript-obfuscator and its size/startup cost
// is measured and reported (src-tauri/README.md "Hardening"). It runs on our Team chunk only.
const obfuscate = isTeam && process.env.BP_OBFUSCATE === '1'

// A moderate javascript-obfuscator pass over the Team chunk (our code), never vendored libraries.
// Loaded lazily so it's only needed when BP_OBFUSCATE=1.
function obfuscateTeamChunk(): Plugin {
  return {
    name: 'bp-obfuscate-team',
    enforce: 'post',
    apply: 'build',
    async generateBundle(_options: Rollup.NormalizedOutputOptions, bundle: Rollup.OutputBundle) {
      const mod = await import('javascript-obfuscator')
      const run = (mod.default ?? mod).obfuscate
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue
        if (file.name !== 'team' && !file.fileName.includes('team')) continue
        file.code = run(file.code, {
          compact: true,
          controlFlowFlattening: true,
          controlFlowFlatteningThreshold: 0.5, // moderate: full flattening is slow at runtime
          deadCodeInjection: false,            // keep size and startup sane
          stringArray: true,
          stringArrayThreshold: 0.75,
          stringArrayEncoding: ['base64'],
          identifierNamesGenerator: 'mangled',
          selfDefending: false,                // can trip source-map-less debuggers, no real gain
          sourceMap: false,
        }).getObfuscatedCode()
      }
    },
  }
}

// Tauri serves the built files from disk, so assets use relative paths.
//
// Editions (docs/editions.md): the private Team module is linked in at src/edition/team
// (scripts/link-team.sh). preserveSymlinks keeps its files at the link's path, so its bare
// imports (react, firebase, …) resolve from this app's node_modules and only one React is
// bundled. It imports open code as `@bp/…` (= src/…), never by relative path.
export default defineConfig({
  plugins: [react(), ...(obfuscate ? [obfuscateTeamChunk()] : [])],
  base: './',
  clearScreen: false,
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version) },
  resolve: {
    preserveSymlinks: true,
    alias: [{ find: /^@bp\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)) }],
  },
  server: { port: 1420, strictPort: true },
  build: {
    target: 'safari16',
    outDir: 'dist',
    // No source maps ship, in either edition: they would hand over the readable sources.
    sourcemap: false,
    // Community: Vite's default minifier (oxc in this Vite/Rolldown), plain. Team: terser, which
    // also strips console and debugger and can mangle properties (scoped so it's safe, see below).
    minify: isTeam ? 'terser' : true,
    terserOptions: isTeam
      ? {
          compress: { drop_console: true, drop_debugger: true, passes: 2 },
          format: { comments: false },
          mangle: {
            // Property mangling is only safe when scoped: Firebase, React, Tauri IPC and the JSON
            // test/workspace formats all rely on property names surviving. So mangle only our own
            // deliberately-private properties, those named with a `_bp_` prefix. Broad property
            // mangling is intentionally NOT enabled.
            properties: { regex: /^_bp_/ },
          },
        }
      : undefined,
    rollupOptions: {
      output: {
        // Keep our Team code in its own chunk (so an obfuscation pass can target it) and keep the
        // heavy Firebase SDK in a separate vendor chunk, which we never obfuscate.
        manualChunks: isTeam
          ? (id: string) => {
              if (/[\\/](firebase|@firebase|@grpc|@protobufjs)[\\/]/.test(id)) return 'vendor-firebase'
              if (id.includes('/edition/team/')) return 'team'
              return undefined
            }
          : undefined,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // `npx vitest run --coverage` (CI, for the README badge). Counts every source file, tested
    // or not. With the Team module linked its files are under src/edition/team and count too.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
})

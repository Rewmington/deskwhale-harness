import { defineConfig } from 'tsdown'

/**
 * The desktop shell bundles one entry: the Electron main process, compiled to
 * ESM (the repo is all-ESM). The preload stays hand-written CommonJS
 * (apps/desktop/preload.cjs) — sandboxed preloads must be CJS and it has no
 * imports of its own. Electron and the workspace runtime packages resolve at
 * runtime from the packaged node_modules, never bundled here.
 */
export default defineConfig({
  entry: ['lib/types/main.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['electron'],
  },
})

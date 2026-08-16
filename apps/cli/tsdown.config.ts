import { defineConfig } from 'tsdown'

/**
 * The dsh CLI ships two entries: the `bin` referenced by package.json `bin`,
 * and the programmatic `api` (runProfile) consumed by desktop shells embedding
 * a dsh profile in-process. The root tsdown builds only `lib/types/index.js`,
 * so this override points at `lib/types/bin.js` instead; its reachable mode
 * modules bundle with it. profile-boot.js bundles the same reachable modules,
 * so the shared chunk carries them once. Declarations come from `tsc -b`
 * (dts: false), matching every package.
 */
export default defineConfig({
  entry: ['lib/types/bin.js', 'lib/types/profile-boot.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})

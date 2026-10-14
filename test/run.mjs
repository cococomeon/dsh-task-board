/**
 * Bundle one TypeScript test entry with the fork's own esbuild and run it under
 * node, so a test drives ./src through the very bundler `pnpm build` uses
 * instead of a hand-transcribed copy of the types.
 *
 * Usage: node test/run.mjs test/<entry>.ts
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const entry = resolve(process.argv[2] ?? 'test/ledger-invariants.entry.ts')
const outfile = join(mkdtempSync(join(tmpdir(), 'tb-test-')), 'bundle.mjs')
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile,
  logLevel: 'warning',
})
const run = spawnSync(process.execPath, [outfile, ...process.argv.slice(3)], { stdio: 'inherit' })
process.exit(run.status ?? 1)

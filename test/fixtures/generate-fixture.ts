/**
 * One-shot authoring helper: builds the frozen ledger snapshot the two
 * self-contained tests read (`test/fixtures/ledger-v6-snapshot.json`).
 *
 * It is NOT a test and nothing imports it. It lives under `fixtures/` rather
 * than `test/` on purpose: a file named `test/*.entry.ts` would be picked up as
 * a test by the suite glob, and regenerating the fixture is not a check. It
 * exists so the fixture has exactly the shape `HostTaskLedger` writes, instead
 * of a hand-typed document that would silently drift from the loader.
 *
 * Usage: node test/run.mjs test/fixtures/generate-fixture.ts
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { HostTaskLedger } from '../../src/host-ledger.ts'

/** Fixed clock: every instant in the fixture is reproducible. */
const NOW = 1_760_000_000_000
const OUT = resolve('test/fixtures/ledger-v6-snapshot.json')

const dir = mkdtempSync(join(tmpdir(), 'tb-fixture-'))
const ledger = new HostTaskLedger(dir, () => NOW)

// Row order matters: the invariant dump moves/renames the first two cards by
// id, and `run` refuses a card that already has an execution, so the first two
// stay execution-free on purpose.
ledger.applyRequest('fixture-1', {
  kind: 'create',
  id: 'fixture-alpha',
  input: { title: 'fixture alpha', description: 'frozen row', prompt: 'p' },
}, 'session-fixture-alpha-0001')
ledger.applyRequest('fixture-2', {
  kind: 'create',
  id: 'fixture-beta',
  input: { title: 'fixture beta', description: 'frozen row', prompt: 'p' },
})
ledger.applyRequest('fixture-3', {
  kind: 'create',
  id: 'fixture-gamma',
  input: { title: 'fixture gamma', description: 'frozen row', prompt: 'p' },
}, 'session-fixture-gamma-0001')
// gamma carries one SETTLED execution, so the load path parses an execution
// record from the fixture; alpha/beta stay clean for the invariant replay.
ledger.applyRequest('fixture-4', { kind: 'run', taskId: 'fixture-gamma' })
const opened = ledger.getTask('fixture-gamma')?.executions.at(-1)
if (opened === undefined) throw new Error('fixture: the run opened no execution')
ledger.settle('fixture-gamma', opened.id, 'succeeded')
ledger.applyRequest('fixture-5', { kind: 'archive', taskId: 'fixture-gamma' })
ledger.applyRequest('fixture-6', { kind: 'restore', taskId: 'fixture-gamma' })
ledger.dispose()

const document = JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')) as {
  scheduler?: { ledgerId?: string }
  tasks?: { executions?: { id?: string; runGroupId?: string }[] }[]
}
// A frozen, readably-labelled identity instead of a random uuid: this file is
// committed, and a fixture that looks like a copy of someone's board invites
// exactly the "is this real data" question it must never raise.
if (document.scheduler !== undefined) document.scheduler.ledgerId = 'fixture-ledger-0001'
// Run ids are minted at random, so they are normalized too: without this the
// fixture would differ on every regeneration and its pinned sha256 (see
// test/fixtures/ledger-fixture.ts) could never be reproduced on purpose.
for (const task of document.tasks ?? []) {
  for (const [index, execution] of (task.executions ?? []).entries()) {
    execution.id = `exec-fixture-${String(index + 1).padStart(2, '0')}`
    if (execution.runGroupId !== undefined) execution.runGroupId = `group-fixture-${String(index + 1).padStart(2, '0')}`
  }
}

mkdirSync(resolve('test/fixtures'), { recursive: true })
writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' })
process.stdout.write(`wrote ${OUT}\n${JSON.stringify(document.tasks.map(task => (task as { id: string }).id))}\n`)

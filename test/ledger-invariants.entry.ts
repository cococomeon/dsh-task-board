/**
 * Canonical dump of the existing ledger transitions, for a before/after diff.
 *
 * It loads the FROZEN v6 snapshot in `test/fixtures/` (see
 * `fixtures/ledger-fixture.ts` for why it is not the live board), replays a
 * fixed action sequence through the real HostTaskLedger, and prints every
 * stored field except the newly added `createdBySessionId` (plus
 * non-reproducible ids). Running this file against the src tree from before the
 * change and again after it must produce byte identical output: that is what
 * "no existing field moved" means here.
 *
 * To compare two trees, point TB_FIXTURE_LEDGER at the other tree's copy of the
 * fixture (or copy the fixture next to the other entry) — the document itself
 * is committed, so both runs replay identical input.
 *
 * The replay is also self-checked: the assertions after it prove every action
 * actually landed. Without them a dump that stopped applying (a refused action,
 * a renamed column) would still print plausible-looking JSON and the diff would
 * compare two equally-broken trees.
 *
 * Usage: node test/run.mjs test/ledger-invariants.entry.ts
 */
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import type { TaskBoardAction } from '../src/protocol.ts'
import { FIXTURE_LEDGER_PATH, FIXTURE_TASK_COUNT, readFixtureLedger } from './fixtures/ledger-fixture.ts'

/** Fixed clock: every stamped instant and every computed trigger is reproducible. */
const NOW = 1_760_000_000_000

// The fixture's digest and row list are verified on read: this dump may only
// ever describe the committed input.
const { fixture, digest } = readFixtureLedger()
const [firstReal, secondReal] = fixture.tasks.map(task => task.id)
assert.ok(firstReal !== undefined && secondReal !== undefined, 'the fixture needs two tasks')
assert.equal(fixture.tasks.length, FIXTURE_TASK_COUNT)

const dir = mkdtempSync(join(tmpdir(), 'tb-invariants-'))
copyFileSync(FIXTURE_LEDGER_PATH, join(dir, 'ledger-v2.json'))
const ledger = new HostTaskLedger(dir, () => NOW)

let seq = 0
const request = (action: TaskBoardAction, initiator?: string) => {
  seq += 1
  return ledger.applyRequest(`invariant-${seq}`, action, initiator)
}

request({ kind: 'create', id: 'invariant-new', input: { title: 'created by the invariant run', description: 'd', prompt: 'p' } }, 'session-invariant-0001')
request({ kind: 'move', taskId: firstReal, status: 'done' })
request({ kind: 'update', taskId: firstReal, patch: { title: 'renamed', model: 'provider/model' } })
request({ kind: 'archive', taskId: secondReal })
request({ kind: 'restore', taskId: secondReal })
request({ kind: 'set-parent', taskId: 'invariant-new', parentId: firstReal })
request({ kind: 'set-schedule', taskId: secondReal, patch: { enabled: true, cron: '*/5 * * * *' } })
request({ kind: 'run', taskId: secondReal })
request({ kind: 'record-external-outcome', taskId: 'invariant-new', result: 'succeeded', initiatedBy: 'outside-agent' })

// --- the replay really happened (guards the dump itself) --------------------
{
  const first = ledger.getTask(firstReal)
  const second = ledger.getTask(secondReal)
  const created = ledger.getTask('invariant-new')
  assert.equal(first?.status, 'done', `${firstReal} was not moved`)
  assert.equal(first?.title, 'renamed', `${firstReal} was not renamed`)
  assert.equal(first?.model, 'provider/model', `${firstReal} lost its pinned model`)
  assert.equal(second?.archivedAt, undefined, `${secondReal} was not restored`)
  assert.equal(second?.schedule?.enabled, true, `${secondReal} has no armed schedule`)
  assert.equal(second?.executions.length, 1, `${secondReal} has no execution record`)
  assert.equal(second?.executions[0]?.endedAt, undefined, 'the run must still be open at dump time')
  assert.equal(created?.parentId, firstReal, 'invariant-new is not a subtask of the first row')
  assert.equal(created?.status, 'done', 'record-external-outcome did not settle the new card')
  assert.equal(created?.createdBySessionId, 'session-invariant-0001', 'the create initiator was not stamped')
  assert.equal(ledger.state().tasks.length, FIXTURE_TASK_COUNT + 1, 'the create did not add exactly one row')
  process.stderr.write(`ledger-invariants: replay verified (fixture ${digest.slice(0, 12)}…, ${FIXTURE_TASK_COUNT} rows + 1 created)\n`)
}

/** Recursively sort object keys so a property-order change cannot masquerade as one. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => [key, sortKeys(nested)]),
  )
}

const state = ledger.state()
const canonical = state.tasks.map((task, taskIndex) => {
  // The one field this change adds is dropped from the dump: the diff must show
  // that nothing ELSE moved.
  const { createdBySessionId, ...rest } = task
  void createdBySessionId
  return {
    ...rest,
    executions: rest.executions.map((execution, executionIndex) => ({
      ...execution,
      id: `exec-${taskIndex}-${executionIndex}`,
      ...(execution.runGroupId === undefined ? {} : { runGroupId: `group-${taskIndex}-${executionIndex}` }),
    })),
  }
})

console.log(JSON.stringify(sortKeys({ tasks: canonical, revision: state.revision, schedulerError: state.scheduler.error }), null, 2))
ledger.dispose()

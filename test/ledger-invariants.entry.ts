/**
 * Canonical dump of the existing ledger transitions, for a before/after diff.
 *
 * It loads the real v6 document, replays a fixed action sequence through the
 * real HostTaskLedger, and prints every stored field except the newly added
 * `createdBySessionId` (plus non-reproducible ids). Running this file against
 * the src tree from before the change and again after it must produce byte
 * identical output: that is what "no existing field moved" means here.
 *
 * Usage: node test/run.mjs test/ledger-invariants.entry.ts
 */
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import type { TaskBoardAction } from '../src/protocol.ts'

const REAL_LEDGER = process.env.TB_REAL_LEDGER ?? '/Users/lee/.dsh/task-board/ledger-v2.json'
/** Fixed clock: every stamped instant and every computed trigger is reproducible. */
const NOW = 1_760_000_000_000

const source = JSON.parse(readFileSync(REAL_LEDGER, 'utf8')) as { tasks: { id: string }[] }
const [firstReal, secondReal] = source.tasks.map(task => task.id)
if (firstReal === undefined || secondReal === undefined) throw new Error('the sample ledger needs two tasks')

const dir = mkdtempSync(join(tmpdir(), 'tb-invariants-'))
copyFileSync(REAL_LEDGER, join(dir, 'ledger-v2.json'))
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

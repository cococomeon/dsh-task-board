/**
 * Card warnings: the durable trace of a decision that diverged from what the
 * card asked for.
 *
 * The failure this covers was silent in the ledger: a run that could not read
 * the session roster started a fresh conversation anyway, or kept its column
 * waiting, and nothing on the card said so. These assertions prove the channel
 * actually persists, survives a reload, drops a malformed row instead of losing
 * the card, and stays bounded.
 *
 * Usage: node test/run.mjs test/card-warnings.entry.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendTaskWarning, TASK_WARNING_LIMIT, type TaskWarning } from '../src/core/tasks.ts'
import { HostTaskLedger } from '../src/host-ledger.ts'

const NOW = 1_760_000_000_000
const dir = mkdtempSync(join(tmpdir(), 'tb-warnings-'))
const ledger = new HostTaskLedger(dir, () => NOW)

// A card that the board can warn about.
const created = ledger.applyRequest(
  'req-create',
  { kind: 'create', id: 'task-warning-fixture', input: { title: 'warning fixture', prompt: 'p', description: '' } } as never,
  'test',
)
const taskId = created.state.tasks.find(task => task.title === 'warning fixture')?.id
assert.ok(taskId !== undefined, 'the fixture card was created')

// 1. A warning appended to the card is stored on the card record.
const base = ledger.getTask(taskId)
assert.ok(base !== undefined)
const warning: TaskWarning = {
  id: 'warn-1',
  at: NOW,
  code: 'session-roster-unreadable',
  message: 'roster unreadable',
}
ledger.saveTaskRecord({ ...base, warnings: appendTaskWarning([], warning) })
const stored = ledger.getTask(taskId)
assert.deepEqual(stored?.warnings, [warning], 'the warning is on the card')
assert.equal(stored?.status, base.status, 'a warning never moves the card')

// The ledger takes an exclusive lock per directory, so a reload means closing
// the previous handle first — which is exactly what a process restart does.
ledger.dispose()

// 2. The warning survives an on-disk round trip, which is the whole point:
//    the user reads it after a restart, not only in the emitting process.
const reopened = new HostTaskLedger(dir, () => NOW)
assert.deepEqual(reopened.getTask(taskId)?.warnings, [warning], 'the warning survives a reload')
reopened.dispose()

// 3. A malformed persisted row is dropped, and the card itself is kept.
const path = join(dir, 'ledger-v2.json')
const doc = JSON.parse(readFileSync(path, 'utf8'))
const row = doc.tasks.find((task: { id: string }) => task.id === taskId)
row.warnings = [{ id: 'ok', at: NOW, code: 'c', message: 'kept' }, { code: '' }, 'junk', { id: 'x', at: Number.NaN, code: 'c', message: 'no' }]
writeFileSync(path, JSON.stringify(doc))
const reopenedAgain = new HostTaskLedger(dir, () => NOW)
const sanitized = reopenedAgain.getTask(taskId)
assert.ok(sanitized !== undefined, 'a malformed warning never costs the card')
assert.deepEqual(
  sanitized?.warnings?.map(entry => entry.message),
  ['kept'],
  'only the well-formed warning is kept',
)
reopenedAgain.dispose()

// 4. The list stays bounded, keeping the NEWEST entries.
const many: TaskWarning[] = []
let list = many
for (let index = 0; index < TASK_WARNING_LIMIT + 5; index += 1) {
  list = appendTaskWarning(list, { id: 'w' + index, at: NOW + index, code: 'c', message: 'm' + index })
}
assert.equal(list.length, TASK_WARNING_LIMIT, 'the warning list is capped')
assert.equal(list[list.length - 1]?.message, 'm' + (TASK_WARNING_LIMIT + 4), 'the newest warning is last')
assert.equal(list[0]?.message, 'm5', 'the oldest entries were trimmed')

console.log('card warnings: all assertions passed')
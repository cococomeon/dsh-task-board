/**
 * Executable evidence for the verified lane (contract §1).
 *
 * The column is only worth having if three separate layers agree about it: the
 * pure state machine (`core/tasks.ts`), the ledger transition
 * (`core/use-cases/task-verify.ts` reached through the real `HostTaskLedger`),
 * and the Host service's asynchronous gate (`host-service.ts`, the only place
 * the git side steps may run). Each layer is driven here for real — no
 * transcribed copies of the rules — so a drift between them fails this file
 * instead of shipping.
 *
 * Usage: node test/run.mjs test/verify-flow.entry.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'
import { parseActionEnvelope } from '../src/protocol.ts'
import {
  ALL_STATUSES,
  ARCHIVABLE_STATUSES,
  COLUMNS,
  COLLAPSED_COLUMNS,
  MANUAL_STATUSES,
  RUNNER_SETTLE_STATUSES,
  canMoveManually,
  canVerifyTask,
  createTask,
  type ExecutionRecord,
  type TaskRecord,
  type TaskStatus,
} from '../src/core/tasks.ts'
import { applyVerifyTask } from '../src/core/use-cases/task-verify.ts'

/** Fixed clock: every stamped instant is reproducible. */
const NOW = 1_760_000_000_000
const LATER = NOW + 60_000

function temporaryLedgerDir(): string {
  return mkdtempSync(join(tmpdir(), 'tb-verify-'))
}

/** A card in `status`, optionally carrying one settled execution. */
function card(status: TaskStatus, overrides: Partial<TaskRecord> = {}): TaskRecord {
  return { ...createTask({ title: 't', description: 'd', prompt: 'p' }, NOW, 'card-1'), status, ...overrides }
}

const settled: ExecutionRecord = {
  id: 'exec-1',
  sessionId: 'session-1',
  startedAt: NOW,
  endedAt: NOW + 1,
  result: 'succeeded',
  error: undefined,
}

const open: ExecutionRecord = { ...settled, id: 'exec-open', endedAt: undefined, result: undefined }

// ---------------------------------------------------------------------------
// 1. The six columns and the constants that classify them.
// ---------------------------------------------------------------------------

assert.deepEqual(
  COLUMNS.map(column => column.status),
  ['backlog', 'todo', 'running', 'done', 'verified', 'failed'],
  'COLUMNS must be exactly the six contract columns, in this order',
)
assert.deepEqual(
  COLUMNS.map(column => column.label),
  ['待规划', '待办', '进行中', '已完成', '已验证', '已失败'],
  'every column carries its label',
)
assert.deepEqual([...COLLAPSED_COLUMNS], ['backlog', 'failed'], 'only the two outer columns default to a thin strip')
// Between done and failed is the whole point of the lane: a verified card must
// not be sorted next to a failed one.
assert.ok(
  COLUMNS.findIndex(column => column.status === 'verified') === COLUMNS.findIndex(column => column.status === 'done') + 1
    && COLUMNS.findIndex(column => column.status === 'verified') === COLUMNS.findIndex(column => column.status === 'failed') - 1,
  'verified sits between done and failed',
)

assert.ok(ALL_STATUSES.includes('verified'), "ALL_STATUSES carries 'verified'")
assert.ok(ARCHIVABLE_STATUSES.includes('verified'), "ARCHIVABLE_STATUSES carries 'verified' (a verified card can be archived)")
assert.ok(!MANUAL_STATUSES.includes('verified'), "MANUAL_STATUSES must NOT carry 'verified'")
assert.deepEqual([...MANUAL_STATUSES], ['backlog', 'todo', 'running', 'done', 'failed'], 'backlog stays a manual column')
assert.deepEqual([...RUNNER_SETTLE_STATUSES], ['done', 'failed'], 'a run still settles into done/failed only')

// ---------------------------------------------------------------------------
// 2. Manual-move legality: never INTO verified, always OUT of it.
// ---------------------------------------------------------------------------

assert.equal(canMoveManually('todo', 'verified'), false, 'a drag may not land on verified')
assert.equal(canMoveManually('done', 'verified'), false, 'not even from done: verification is its own action')
assert.equal(canMoveManually('verified', 'done'), true, 'a mistaken verification is retractable by hand')
assert.equal(canMoveManually('verified', 'verified'), false, 'a no-op move is not a move')
assert.equal(canMoveManually('done', 'failed'), true, 'the other manual targets are untouched')

// ---------------------------------------------------------------------------
// 3. The pure predicate.
// ---------------------------------------------------------------------------

assert.equal(canVerifyTask(card('done')), true, 'a settled done card is verifiable')
assert.equal(canVerifyTask(card('done', { executions: [settled] })), true, 'settled history does not block verification')
assert.equal(canVerifyTask(card('todo')), false, 'a todo card is not verifiable')
assert.equal(canVerifyTask(card('running')), false, 'a running card is not verifiable')
assert.equal(canVerifyTask(card('failed')), false, 'a failed card is not verifiable')
assert.equal(canVerifyTask(card('verified')), false, 'an already verified card is not verifiable again')
assert.equal(
  canVerifyTask(card('done', { executions: [open] })),
  false,
  'an unsettled execution blocks verification even in the done column',
)
assert.equal(canVerifyTask(card('done', { archivedAt: NOW })), false, 'an archived card is not verifiable')

// ---------------------------------------------------------------------------
// 4. The use case: one legal transition, every refusal named.
// ---------------------------------------------------------------------------

{
  const applied = applyVerifyTask([card('done', { executions: [settled] })], 'card-1', LATER)
  assert.equal(applied.applied, true, 'done -> verified applies')
  assert.equal(applied.tasks[0].status, 'verified', 'the card lands in verified')
  assert.equal(applied.tasks[0].updatedAt, LATER, 'the transition stamps a fresh updatedAt')
  assert.equal(applied.tasks[0].executions.length, 1, 'verification does not touch the execution history')
}
{
  const refused = applyVerifyTask([card('todo')], 'card-1', LATER)
  assert.equal(refused.applied, false, 'todo -> verified is refused')
  assert.equal(refused.error, 'only a settled done card can be verified')
  assert.equal(refused.tasks[0].status, 'todo', 'a refusal leaves the ledger exactly as it was')
  assert.equal(refused.tasks[0].updatedAt, NOW, 'a refusal does not stamp updatedAt')
}
{
  const refused = applyVerifyTask([card('done', { executions: [open] })], 'card-1', LATER)
  assert.equal(refused.applied, false, 'an open execution is refused')
  assert.equal(refused.error, 'running task cannot be verified')
}
{
  const refused = applyVerifyTask([card('done', { archivedAt: NOW })], 'card-1', LATER)
  assert.equal(refused.applied, false, 'an archived card is refused')
  assert.equal(refused.error, 'archived task is read-only')
}
{
  const refused = applyVerifyTask([card('done')], 'nope', LATER)
  assert.equal(refused.applied, false, 'a missing card is refused')
  assert.equal(refused.error, 'task not found')
}

// ---------------------------------------------------------------------------
// 5. The ledger action: the same gates, reachable through a real applyRequest.
// ---------------------------------------------------------------------------

const ledger = new HostTaskLedger(temporaryLedgerDir(), () => NOW)
let seq = 0
const apply = (action: Parameters<HostTaskLedger['applyRequest']>[1], initiator?: string) => {
  seq += 1
  return ledger.applyRequest(`verify-${seq}`, action, initiator)
}
const statusOf = (id: string): TaskStatus | undefined => ledger.getTask(id)?.status

apply({ kind: 'create', id: 'done-card', input: { title: 'finished', description: 'd', prompt: 'p' } })
apply({ kind: 'create', id: 'todo-card', input: { title: 'not finished', description: 'd', prompt: 'p' } })
apply({ kind: 'move', taskId: 'done-card', status: 'done' })

assert.equal(statusOf('done-card'), 'done')
assert.throws(
  () => apply({ kind: 'verify', taskId: 'todo-card', commit: false, push: false }),
  /only a settled done card can be verified/,
  'the ledger refuses a card that is not done',
)
assert.equal(statusOf('todo-card'), 'todo', 'the refused card did not move')

const verified = apply({ kind: 'verify', taskId: 'done-card', commit: false, push: false })
assert.equal(statusOf('done-card'), 'verified', 'the ledger action moves done -> verified')
assert.equal(verified.state.revision > 0, true, 'the transition produced a ledger revision')

// A verification may only write the state transition: the ledger must not need
// (or touch) git, which is asserted by the two flags being accepted and ignored.
assert.equal(ledger.getTask('done-card')?.updatedAt, NOW, 'the ledger stamps its own clock')

// Retraction is a plain manual move, from any column into any manual one.
apply({ kind: 'move', taskId: 'done-card', status: 'done' })
assert.equal(statusOf('done-card'), 'done', 'a verified card can be dragged back to done')
assert.throws(
  () => apply({ kind: 'move', taskId: 'done-card', status: 'verified' }),
  /invalid manual status/,
  'no manual move may enter verified — the ledger says so, not just the UI',
)
ledger.dispose()

// ---------------------------------------------------------------------------
// 6. The wire parser: strict booleans, no partial action accepted.
// ---------------------------------------------------------------------------

const envelope = (action: unknown): unknown => ({ requestId: 'r-1', action })
{
  const parsed = parseActionEnvelope(envelope({ kind: 'verify', taskId: 't-1', commit: true, push: false }))
  assert.deepEqual(parsed?.action, { kind: 'verify', taskId: 't-1', commit: true, push: false })
}
{
  // A truthy-but-not-true flag is OFF: the parser normalizes rather than trusting.
  const parsed = parseActionEnvelope(envelope({ kind: 'verify', taskId: 't-1', commit: 1, push: 'yes' }))
  assert.deepEqual(parsed?.action, { kind: 'verify', taskId: 't-1', commit: false, push: false })
}
{
  // An absent flag normalizes to OFF rather than rejecting the action: the
  // strict `=== true` rule is what makes a truthy-but-not-true value mean OFF,
  // and an omitted key is the same statement as a false one.
  const parsed = parseActionEnvelope(envelope({ kind: 'verify', taskId: 't-1' }))
  assert.deepEqual(parsed?.action, { kind: 'verify', taskId: 't-1', commit: false, push: false })
}
{
  // The rest of the envelope still has to hold: a verification with no target,
  // or one carrying a field this action does not define, is not a verification.
  assert.equal(parseActionEnvelope(envelope({ kind: 'verify', taskId: '', commit: false, push: false })), undefined)
  assert.equal(parseActionEnvelope(envelope({ kind: 'verify', commit: false, push: false })), undefined)
  assert.equal(parseActionEnvelope(envelope({ kind: 'verify', taskId: 't-1', commit: false, push: false, extra: 1 })), undefined)
}

// ---------------------------------------------------------------------------
// 7. The agent tool surface: readable, never a verification action.
//
// `src/host/agent-tools.ts` imports the DSH tool SDK, which this fork does not
// install (the Host profile supplies it at load time) — so the module cannot be
// bundled into a test at all, and the definitions are NOT inspected here. That
// one contract clause is covered by a mechanical acceptance over the source
// instead, reported with this test's result:
//
//   grep -n "enum: \['move-todo'" src/host/agent-tools.ts   # action enum, no 'verify'
//   grep -n "enum: \['backlog'"   src/host/agent-tools.ts   # status filter, has 'verified'
//
// The shape that clause protects IS asserted below, on the shared constant the
// tool enum is built from: a verification action nobody may call cannot exist
// while `verified` is absent from every manual target list.
// ---------------------------------------------------------------------------

assert.ok(!MANUAL_STATUSES.includes('verified'), 'no surface — agent tool included — has a manual verified target')

// ---------------------------------------------------------------------------
// 8. The Host service: asynchronous gate, git only when asked, refusal text.
// ---------------------------------------------------------------------------

const serviceLedger = new HostTaskLedger(temporaryLedgerDir(), () => NOW)
const workspaces = [
  { id: 'ws-1', updatedAt: new Date(NOW).toISOString(), sessionIds: [], path: '/tmp/tb-verify-ws-1' },
]
const service = new TaskBoardHostService({} as never, {
  ledger: serviceLedger,
  now: () => NOW,
  workspaceRegistry: { list: () => workspaces as never },
  gitRemote: () => 'review-origin',
})
let request = 0
const submit = (action: Parameters<typeof service.apply>[1]) => service.apply(`service-${++request}`, action as never)

// The service mirrors the ledger's gates before it reaches them, so a caller
// gets one refusal vocabulary regardless of which layer caught it.
await assert.rejects(
  async () => await submit({ kind: 'verify', taskId: 'missing', commit: false, push: false }),
  /task not found/,
)
serviceLedger.saveTaskRecord(card('todo', { id: 'service-todo' }))
await assert.rejects(
  async () => await submit({ kind: 'verify', taskId: 'service-todo', commit: false, push: false }),
  /only a settled done card can be verified/,
)
assert.equal(serviceLedger.getTask('service-todo')?.status, 'todo', 'the refused card did not move')

// The other two ledger gates hold at this layer as well: an archived card and a
// card whose run is still open. Both are checked before any git call, so a
// refusal never touches the repository.
serviceLedger.saveTaskRecord(card('done', { id: 'service-archived', archivedAt: NOW }))
await assert.rejects(
  async () => await submit({ kind: 'verify', taskId: 'service-archived', commit: false, push: false }),
  /archived task is read-only/,
)
serviceLedger.saveTaskRecord(card('done', { id: 'service-open', executions: [open] }))
await assert.rejects(
  async () => await submit({ kind: 'verify', taskId: 'service-open', commit: false, push: false }),
  /running task cannot be verified/,
)
assert.equal(serviceLedger.getTask('service-open')?.status, 'done', 'an unsettled execution leaves the card in done')

// No git flags: the git step is skipped entirely, so a card whose workspace
// would be unusable still verifies and the returned snapshot shows it.
serviceLedger.saveTaskRecord(card('done', { id: 'service-done', title: 'ship it' }))
const snapshot = await submit({ kind: 'verify', taskId: 'service-done', commit: false, push: false })
assert.equal(snapshot.tasks.find(task => task.id === 'service-done')?.status, 'verified', 'the service verifies a settled done card')

// A git step with no resolvable workspace is refused, never silently skipped:
// the card must not read as verified when the requested commit never ran.
serviceLedger.saveTaskRecord(card('done', { id: 'service-orphan', workspaceId: 'ws-gone' }))
await assert.rejects(
  async () => await submit({ kind: 'verify', taskId: 'service-orphan', commit: true, push: false }),
  /no workspace resolves/,
)
assert.equal(
  serviceLedger.getTask('service-orphan')?.status,
  'done',
  'a failed git preflight leaves the card in done',
)
service.dispose()
serviceLedger.dispose()

console.log('verify-flow: ok — 8 groups, all assertions passed')

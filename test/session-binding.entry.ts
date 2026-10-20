/**
 * Real-path checks for turn <-> card binding (`host/session-binder.ts`).
 *
 * Everything here drives the actual SessionBinder and SessionChoiceStore
 * against a real HostTaskLedger on a temp copy of the board's data directory
 * (bundled by test/run.mjs through the same esbuild `pnpm build` uses). No
 * hand-built stand-in decides a column: the columns asserted below are the ones
 * the ledger wrote.
 *
 * Usage: node test/run.mjs test/session-binding.entry.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { SessionChoiceStore } from '../src/host/session-choice.ts'
import { SessionBinder } from '../src/host/session-binder.ts'
import { bindingCandidates, settleStatusOf } from '../src/core/session-binding.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_760_000_000_000
const SESSION = 'session-bind-1111-2222-3333-444455556666'
const OTHER_SESSION = 'session-bind-other'

const line = (label: string, value?: unknown): void => {
  process.stdout.write(`  ok  ${label}${value === undefined ? '' : ` -> ${JSON.stringify(value)}`}\n`)
}

const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))

/** One card with an execution that ran in `sessionId`, written straight into the ledger. */
function card(
  ledger: HostTaskLedger,
  id: string,
  options: {
    sessionId?: string
    createdBy?: string
    status?: TaskRecord['status']
    archived?: boolean
    openExecution?: boolean
    at?: number
  } = {},
): TaskRecord {
  const at = options.at ?? NOW
  const base = createTask({
    title: `card ${id}`,
    description: '',
    prompt: 'p',
    ...(options.createdBy === undefined ? {} : { createdBySessionId: options.createdBy }),
  }, at, id)
  const execution: ExecutionRecord | undefined = options.sessionId === undefined
    ? undefined
    : {
      id: `exec-${id}`,
      sessionId: options.sessionId,
      startedAt: at,
      endedAt: options.openExecution === true ? undefined : at + 10,
      result: options.openExecution === true ? undefined : 'succeeded',
      error: undefined,
    }
  const task: TaskRecord = {
    ...base,
    status: options.status ?? 'todo',
    executions: execution === undefined ? [] : [execution],
    ...(options.archived === true ? { archivedAt: at + 20 } : {}),
  }
  ledger.saveTaskRecord(task)
  return task
}

/** Wait (bounded) until the binder has raised a prompt. */
async function waitForPrompt(binder: SessionBinder, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (binder.pendingPrompts().length === 0) {
    if (Date.now() > deadline) throw new Error('no binding prompt was raised')
    await new Promise(resolve => setImmediate(resolve))
  }
}

/** A binder over a fresh ledger + choice store, with knobs for the safety valves. */
function binderOver(options: {
  subscribers?: boolean
  waitMs?: number
  session?: string
} = {}): {
  ledger: HostTaskLedger
  binder: SessionBinder
  choices: SessionChoiceStore
  dir: string
  calls: { published: number; subscriberProbes: number }
} {
  const dir = tempDir('tb-bind-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  const choices = new SessionChoiceStore(tempDir('tb-choice-'), () => NOW)
  const calls = { published: 0, subscriberProbes: 0 }
  const binder = new SessionBinder({
    ledger,
    choices,
    hasSubscribers: () => {
      calls.subscriberProbes += 1
      return options.subscribers !== false
    },
    publish: () => { calls.published += 1 },
    now: () => NOW,
    waitMs: options.waitMs ?? 5_000,
  })
  return { ledger, binder, choices, dir, calls }
}

/** The column the ledger currently holds for one card. */
const statusOf = (ledger: HostTaskLedger, id: string): string => {
  const task = ledger.getTask(id)
  assert.ok(task !== undefined, `card ${id} is missing from the ledger`)
  return task.status
}

const noSignal = new AbortController()

// --- A: candidate filtering (archived / verified / open execution) ------------
{
  const { ledger } = binderOver()
  card(ledger, 'live', { sessionId: SESSION })
  card(ledger, 'archived', { sessionId: SESSION, archived: true })
  card(ledger, 'verified', { sessionId: SESSION, status: 'verified' })
  card(ledger, 'openrun', { sessionId: SESSION, status: 'running', openExecution: true })
  card(ledger, 'foreign', { sessionId: OTHER_SESSION })
  const ids = bindingCandidates(ledger.allTasks(), SESSION).map(entry => entry.task.id)
  assert.deepEqual(ids, ['live'])
  line('only the bindable card survives (archived/verified/open-execution excluded)', ids)
}

// --- B: zero candidates is a no-op ------------------------------------------
{
  const { ledger, binder } = binderOver()
  card(ledger, 'foreign', { sessionId: OTHER_SESSION })
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  assert.deepEqual(binder.pendingPrompts(), [])
  assert.equal(statusOf(ledger, 'foreign'), 'todo')
  line('0 candidates -> nothing asked, nothing written')
}

// --- C: exactly one candidate -> running, without asking ---------------------
{
  const { ledger, binder } = binderOver()
  card(ledger, 'solo', { sessionId: SESSION })
  assert.deepEqual(binder.pendingPrompts(), [])
  const pending = binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  await pending
  assert.equal(statusOf(ledger, 'solo'), 'running')
  line('1 candidate -> running directly')
}

// --- D: several candidates, user picks -> running + sticky memory ------------
{
  const { ledger, binder, choices } = binderOver({ waitMs: 5_000 })
  card(ledger, 'newest', { sessionId: SESSION, at: NOW + 100 })
  card(ledger, 'older', { sessionId: SESSION, createdBy: SESSION, at: NOW })
  const turn = binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  await waitForPrompt(binder)
  const prompt = binder.pendingPrompts()[0]
  assert.deepEqual(prompt.candidates.map(card => card.taskId), ['newest', 'older'])
  assert.equal(prompt.deadlineAt, NOW + 5_000)
  assert.equal(binder.resolveChoice(SESSION, 'older'), true)
  await turn
  assert.equal(statusOf(ledger, 'older'), 'running')
  assert.equal(statusOf(ledger, 'newest'), 'todo')
  assert.equal(choices.get(SESSION), 'older')
  line('2 candidates -> modal choice wins, the other card is untouched', choices.get(SESSION))
}

// --- E: the remembered answer is sticky for later turns ----------------------
{
  const { ledger, binder, choices } = binderOver()
  card(ledger, 'a', { sessionId: SESSION, at: NOW + 100 })
  card(ledger, 'b', { sessionId: SESSION, at: NOW })
  choices.set(SESSION, 'b')
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'b'), 'running')
  assert.equal(statusOf(ledger, 'a'), 'todo')
  assert.deepEqual(binder.pendingPrompts(), [])
  line('sticky choice -> second turn asks nothing')

  // Turn 1 settled b to done; the next turn must re-bind the SAME card.
  binder.afterTurn(SESSION, 1, { kind: 'completed' })
  assert.equal(statusOf(ledger, 'b'), 'done')
  await binder.beforeTurn(SESSION, 2, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'b'), 'running')
  line('sticky choice survives a settle and re-binds the same card')
}

// --- F: an invalidated memory asks again ------------------------------------
{
  const { ledger, binder, choices } = binderOver({ waitMs: 5_000 })
  card(ledger, 'c1', { sessionId: SESSION, at: NOW + 300 })
  card(ledger, 'c2', { sessionId: SESSION, at: NOW + 200 })
  card(ledger, 'gone', { sessionId: SESSION, at: NOW })
  choices.set(SESSION, 'deleted-card-id')

  const turnForDeleted = binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  await waitForPrompt(binder)
  assert.deepEqual(binder.pendingPrompts()[0].candidates.map(card => card.taskId), ['c1', 'c2', 'gone'])
  binder.resolveChoice(SESSION, null)
  await turnForDeleted
  assert.equal(statusOf(ledger, 'gone'), 'todo')
  line('memory naming a deleted card -> asked again (and "none this turn" binds nothing)')

  // Archived: the remembered card still exists but left the board, so the two
  // remaining candidates raise the question again.
  choices.set(SESSION, 'gone')
  await binder.beforeTurn(SESSION, 2, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'gone'), 'running')
  binder.afterTurn(SESSION, 2, { kind: 'completed' })
  assert.equal(statusOf(ledger, 'gone'), 'done')
  ledger.saveTaskRecord({ ...ledger.getTask('gone')!, archivedAt: NOW + 999 })

  const turnForArchived = binder.beforeTurn(SESSION, 3, 1, noSignal.signal)
  await waitForPrompt(binder)
  assert.deepEqual(binder.pendingPrompts()[0].candidates.map(card => card.taskId), ['c1', 'c2'])
  binder.resolveChoice(SESSION, 'c1')
  await turnForArchived
  assert.equal(statusOf(ledger, 'c1'), 'running')
  line('memory naming an archived card -> asked again')
}

// --- G: turn/end reason -> settle column ------------------------------------
{
  assert.equal(settleStatusOf('completed'), 'done')
  for (const kind of ['error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked', 'something-new']) {
    assert.equal(settleStatusOf(kind), 'failed', `${kind} must fail the card`)
  }
  line('reason mapping', { completed: 'done', 'everything else': 'failed' })

  const { ledger, binder } = binderOver()
  card(ledger, 'turns', { sessionId: SESSION })
  for (const [turn, reason, expected] of [
    [1, { kind: 'completed' }, 'done'],
    [2, { kind: 'aborted', reason: { kind: 'user' } }, 'failed'],
    [3, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } }, 'failed'],
    [4, { kind: 'max-tokens' }, 'failed'],
    [5, { kind: 'interrupted' }, 'failed'],
    [6, { kind: 'blocked' }, 'failed'],
  ] as const) {
    await binder.beforeTurn(SESSION, turn, 1, noSignal.signal)
    assert.equal(statusOf(ledger, 'turns'), 'running')
    binder.afterTurn(SESSION, turn, reason)
    assert.equal(statusOf(ledger, 'turns'), expected, `turn ${turn} (${reason.kind})`)
  }
  line('turn/end settles every reason kind on a real card')
}

// --- H: one pass per turn (step 2 and a repeated step 1 are no-ops) ---------
{
  const { ledger, binder, calls } = binderOver({ waitMs: 5_000 })
  card(ledger, 'once', { sessionId: SESSION, at: NOW + 100 })
  card(ledger, 'twice', { sessionId: SESSION, at: NOW })
  const turn = binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  await waitForPrompt(binder)
  const publishedAfterPrompt = calls.published
  binder.resolveChoice(SESSION, 'twice')
  await turn
  const publishedAfterAnswer = calls.published
  assert.ok(publishedAfterAnswer > publishedAfterPrompt, 'the answer must clear the prompt frame')

  // A later STEP of the same turn: no write, no prompt, no second bind.
  const archivedOther = { ...ledger.getTask('once')! }
  ledger.saveTaskRecord(archivedOther)
  await binder.beforeTurn(SESSION, 1, 2, noSignal.signal)
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  assert.equal(calls.published, publishedAfterAnswer)
  assert.deepEqual(binder.pendingPrompts(), [])
  assert.equal(statusOf(ledger, 'twice'), 'running')
  line('turn dedupe -> steps 2 and a repeat of step 1 do nothing')

  // A NEW turn does bind again.
  binder.afterTurn(SESSION, 1, { kind: 'completed' })
  await binder.beforeTurn(SESSION, 2, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'twice'), 'running')
  line('a new turn binds again (dedupe is per turn, not per session)')
}

// --- I: no subscriber -> no wait, most recent card wins ---------------------
{
  const { ledger, binder } = binderOver({ subscribers: false, waitMs: 30_000 })
  card(ledger, 'recent', { sessionId: SESSION, at: NOW + 100 })
  card(ledger, 'stale', { sessionId: SESSION, at: NOW })
  const startedAt = Date.now()
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1_000, `a subscriber-less deployment must not wait (took ${elapsed}ms)`)
  assert.equal(statusOf(ledger, 'recent'), 'running')
  assert.equal(statusOf(ledger, 'stale'), 'todo')
  assert.deepEqual(binder.pendingPrompts(), [])
  line('no SSE subscriber -> fallback to the most recently linked card, no wait', `${elapsed}ms`)
}

// --- J: the wait is bounded (deadline) and falls back ---------------------
{
  const { ledger, binder, choices } = binderOver({ waitMs: 60 })
  card(ledger, 'recent', { sessionId: SESSION, at: NOW + 100 })
  card(ledger, 'stale', { sessionId: SESSION, at: NOW })
  const startedAt = Date.now()
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed >= 50 && elapsed < 2_000, `waited ${elapsed}ms, expected ~60ms`)
  assert.equal(statusOf(ledger, 'recent'), 'running')
  assert.equal(choices.get(SESSION), undefined, 'a timeout must not become the sticky answer')
  line('deadline expiry -> bounded wait then the most recent card', `${elapsed}ms`)
}

// --- K: signal abort releases immediately ----------------------------------
{
  const { ledger, binder } = binderOver({ waitMs: 30_000 })
  card(ledger, 'recent', { sessionId: SESSION, at: NOW + 100 })
  card(ledger, 'stale', { sessionId: SESSION, at: NOW })
  const abort = new AbortController()
  const startedAt = Date.now()
  const turn = binder.beforeTurn(SESSION, 1, 1, abort.signal)
  await waitForPrompt(binder)
  abort.abort()
  await turn
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1_000, `an aborted turn must be released at once (took ${elapsed}ms)`)
  assert.deepEqual(binder.pendingPrompts(), [])
  line('signal abort -> released immediately', `${elapsed}ms`)
}

// --- L: no fighting the runner ----------------------------------------------
{
  const { ledger, binder } = binderOver()
  card(ledger, 'runnerOwned', { sessionId: SESSION, status: 'running', openExecution: true })
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'runnerOwned'), 'running')
  const before = ledger.getTask('runnerOwned')!
  assert.equal(before.executions[0].endedAt, undefined, 'the open execution must stay open')
  line('a card with an open execution is never touched')
}

// --- M: the sticky memory is its own atomically written file ----------------
{
  const dir = tempDir('tb-choice-inspect-')
  const store = new SessionChoiceStore(dir, () => NOW)
  store.set(SESSION, 'card-a')
  const document = JSON.parse(readFileSync(join(dir, 'session-choice.json'), 'utf8')) as {
    version: number
    choices: Record<string, { taskId: string; chosenAt: number }>
  }
  assert.equal(document.version, 1)
  assert.deepEqual(document.choices[SESSION], { taskId: 'card-a', chosenAt: NOW })
  const reloaded = new SessionChoiceStore(dir, () => NOW)
  assert.equal(reloaded.get(SESSION), 'card-a')
  // The ledger's own version is untouched by this feature.
  const ledgerDir = tempDir('tb-ledger-doc-')
  const ledger = new HostTaskLedger(ledgerDir, () => NOW)
  card(ledger, 'x', { sessionId: SESSION })
  const ledgerDocument = JSON.parse(readFileSync(join(ledgerDir, 'ledger-v2.json'), 'utf8')) as { schemaVersion: number }
  assert.equal(ledgerDocument.schemaVersion, 6)
  line('session-choice.json is separate, atomic and outside the ledger', document.version)
}

// --- N: a runner-driven turn never binds ------------------------------------
{
  // The shape a `reuseSession` run (or a session that has iterated several
  // cards) leaves behind: one card the runner is executing HERE, plus settled
  // history cards of the same session. Without the runner guard this turn would
  // raise a modal (nobody is looking) and then move an unrelated old card.
  const { ledger, binder, calls } = binderOver({ waitMs: 30_000 })
  card(ledger, 'running-here', { sessionId: SESSION, status: 'running', openExecution: true, at: NOW + 300 })
  card(ledger, 'old-a', { sessionId: SESSION, status: 'done', at: NOW + 200 })
  card(ledger, 'old-b', { sessionId: SESSION, status: 'failed', at: NOW + 100 })
  assert.ok(bindingCandidates(ledger.allTasks(), SESSION).length === 2, 'the settled history IS bindable in principle')

  const startedAt = Date.now()
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1_000, `a runner-driven turn must not wait (took ${elapsed}ms)`)
  assert.deepEqual(binder.pendingPrompts(), [])
  // Zero wait means the subscriber probe was never even consulted.
  assert.equal(calls.subscriberProbes, 0)
  assert.equal(calls.published, 0)
  assert.equal(statusOf(ledger, 'running-here'), 'running')
  assert.equal(statusOf(ledger, 'old-a'), 'done')
  assert.equal(statusOf(ledger, 'old-b'), 'failed')
  line('runner-driven turn (open execution owned by this session) -> no prompt, no move, no probe', `${elapsed}ms`)

  // Nothing was claimed, so no ending can settle anything by this path.
  binder.afterTurn(SESSION, 1, { kind: 'completed' })
  binder.afterTurn(SESSION, 1, { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } })
  assert.equal(statusOf(ledger, 'running-here'), 'running')
  assert.equal(statusOf(ledger, 'old-a'), 'done')
  assert.equal(statusOf(ledger, 'old-b'), 'failed')
  line('turn endings settle nothing the binding path never claimed')

  // The runner keeps ownership: its own settle call is what closes the card,
  // and the binding path never interfered with the open execution.
  const beforeSettle = ledger.getTask('running-here')!
  assert.equal(beforeSettle.executions[0].endedAt, undefined)
  ledger.settle('running-here', 'exec-running-here', 'succeeded')
  assert.equal(statusOf(ledger, 'running-here'), 'done')
  line('the runner still settles its own card (binding never touched the execution)')

  // And once the run is over, the same session binds normally again: the
  // question comes back (the guard is per open execution, not per session).
  const afterRun = binder.beforeTurn(SESSION, 2, 1, noSignal.signal)
  await waitForPrompt(binder)
  assert.deepEqual(binder.pendingPrompts()[0].candidates.map(entry => entry.taskId), ['running-here', 'old-a', 'old-b'])
  binder.resolveChoice(SESSION, 'old-a')
  await afterRun
  assert.equal(statusOf(ledger, 'old-a'), 'running')
  line('after the run ends the session binds normally again')
}

process.stdout.write('\nsession-binding: all checks passed\n')

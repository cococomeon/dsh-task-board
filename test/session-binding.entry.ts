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
import { lastTurnEndOf, readTurnEnd, SessionBinder } from '../src/host/session-binder.ts'
import { bindingCandidates, settleStatusOf } from '../src/core/session-binding.ts'
import { hasBusyDescendant, type LiveAgentState } from '../src/core/subagent-tree.ts'
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
    /** Overrides the row's `updatedAt` (ordering against `endedAt` is a fixture). */
    updatedAt?: number
    /** Overrides the execution's `endedAt` (default: `at + 10`). */
    endedAt?: number
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
      endedAt: options.openExecution === true ? undefined : (options.endedAt ?? at + 10),
      result: options.openExecution === true ? undefined : 'succeeded',
      error: undefined,
    }
  const task: TaskRecord = {
    ...base,
    updatedAt: options.updatedAt ?? base.updatedAt,
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

// --- A: candidate filtering (archived / open execution; verified is bindable) --
{
  const { ledger } = binderOver()
  card(ledger, 'live', { sessionId: SESSION })
  card(ledger, 'archived', { sessionId: SESSION, archived: true })
  card(ledger, 'verified', { sessionId: SESSION, status: 'verified' })
  card(ledger, 'openrun', { sessionId: SESSION, status: 'running', openExecution: true })
  card(ledger, 'foreign', { sessionId: OTHER_SESSION })
  const ids = bindingCandidates(ledger.allTasks(), SESSION).map(entry => entry.task.id)
  assert.deepEqual(ids, ['live', 'verified'])
  line('archived and open-execution cards are excluded; a verified card is bindable', ids)
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

// --- O: the turn/end payload is WRAPPED under `data` (regression) ------------
{
  // The runtime builds every published event as { type, seq, time, data }, so
  // the payload of append('turn/end', { turn, reason }) lands under `data`.
  // Reading turn/reason off the event itself yielded undefined, which made the
  // settle key `${sessionId}#undefined`; it never matched the recorded turn and
  // every bound card stayed in `running` forever.
  const wrapped = { type: 'turn/end', seq: 9, time: 1_700_000_000_000, data: { turn: 4, reason: { kind: 'completed' } } }
  assert.deepEqual(readTurnEnd(wrapped), { turn: 4, reason: { kind: 'completed' } })
  assert.deepEqual(readTurnEnd({ type: 'turn/end', data: { turn: 4 } }), { turn: 4, reason: undefined })
  // A payload sitting ON the event is not what the runtime publishes.
  assert.equal(readTurnEnd({ type: 'turn/end', turn: 4, reason: { kind: 'completed' } } as never), undefined)
  assert.equal(readTurnEnd({ type: 'turn/start', data: { turn: 4 } }), undefined)
  assert.equal(readTurnEnd({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), undefined)
  assert.equal(readTurnEnd(undefined), undefined)
  line('turn/end decode reads the wrapped payload only', readTurnEnd(wrapped))
}

// --- P: a decoded turn/end actually settles the card the turn moved ---------
{
  const { ledger, binder } = binderOver()
  card(ledger, 'bound', { sessionId: SESSION })
  await binder.beforeTurn(SESSION, 7, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'bound'), 'running')

  const end = readTurnEnd({ type: 'turn/end', seq: 3, time: 1, data: { turn: 7, reason: { kind: 'completed' } } })
  assert.ok(end !== undefined, 'the wrapped turn/end must decode')
  if (end !== undefined) binder.afterTurn(SESSION, end.turn, end.reason)
  assert.equal(statusOf(ledger, 'bound'), 'done')
  line('decode + afterTurn settles the bound card (no more stuck running)', statusOf(ledger, 'bound'))
}

// --- P2: a failing turn settles as failed ----------------------------------
{
  // Its own ledger: a second card in the first block would make the next turn a
  // two-candidate turn, which is a different (already covered) path.
  const { ledger, binder } = binderOver()
  card(ledger, 'bound-2', { sessionId: SESSION })
  await binder.beforeTurn(SESSION, 8, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'bound-2'), 'running')
  const failedEnd = readTurnEnd({ type: 'turn/end', data: { turn: 8, reason: { kind: 'error' } } })
  if (failedEnd !== undefined) binder.afterTurn(SESSION, failedEnd.turn, failedEnd.reason)
  assert.equal(statusOf(ledger, 'bound-2'), 'failed')
  line('an error turn settles as failed', statusOf(ledger, 'bound-2'))
}

// --- O: the recovery pass must not undo a card the binding just moved --------
// `finalizeReadyRuns` (the poll tick, and the fold inside import/settle) closes
// a card that sits in `running` with every execution closed: that shape is how
// a crash between "close the execution" and "move the column" looks. It is ALSO
// the shape a card takes when it is moved into `running` after its last run
// closed — which is exactly what the session binding does (it changes the
// column only, never opens an execution). Without an ordering guard the
// recovery pass folds the binding straight back, in the same tick.
{
  // A movable clock: the whole question is the order of `updatedAt` and
  // `endedAt`, and a frozen clock cannot express it.
  let clock = NOW
  const dir = tempDir('tb-bind-o-')
  const ledger = new HostTaskLedger(dir, () => clock)
  const choices = new SessionChoiceStore(tempDir('tb-choice-o-'), () => clock)
  const binder = new SessionBinder({
    ledger,
    choices,
    hasSubscribers: () => false,
    publish: () => {},
    now: () => clock,
    waitMs: 5_000,
  })

  // (a) done + one settled execution (updatedAt === endedAt), then the binding
  //     moves it a second later -> the recovery pass must leave it in running.
  card(ledger, 'o-bound', { sessionId: SESSION, status: 'done', at: NOW, endedAt: NOW, updatedAt: NOW })
  clock = NOW + 1_000
  await binder.beforeTurn(SESSION, 1, 1, noSignal.signal)
  assert.equal(statusOf(ledger, 'o-bound'), 'running', 'the binding did not move the card')
  const afterMove = ledger.getTask('o-bound')!
  assert.ok(afterMove.updatedAt > (afterMove.executions[0].endedAt ?? 0), 'the move did not stamp a later updatedAt')
  clock = NOW + 2_000
  assert.equal(ledger.finalizeReadyRuns(), false, 'the recovery pass folded a card that was moved after its execution closed')
  assert.equal(statusOf(ledger, 'o-bound'), 'running')
  // The OTHER entry point folds too: an import action runs `finalizeReadyRuns`
  // inside its own commit, so a card the binding moved must survive that as
  // well as the poll tick.
  ledger.applyRequest('o-import-1', {
    kind: 'import',
    sourceId: 'o-import-source',
    tasks: [createTask({ title: 'imported while bound', description: '', prompt: 'p' }, NOW, 'o-imported')],
  })
  assert.equal(statusOf(ledger, 'o-bound'), 'running')
  assert.equal(statusOf(ledger, 'o-imported'), 'todo')
  line('B2 nail: done -> bound to running survives the recovery pass', `${afterMove.updatedAt} > ${String(afterMove.executions[0].endedAt)}`)

  // (b) crash residue: running + closed execution + updatedAt === endedAt
  //     -> still folds (the recovery this pass exists for is untouched).
  card(ledger, 'o-crash', { sessionId: SESSION, status: 'running', at: NOW, endedAt: NOW, updatedAt: NOW })
  assert.equal(ledger.finalizeReadyRuns(), true, 'a genuine crash residue was not repaired')
  assert.equal(statusOf(ledger, 'o-crash'), 'done')
  line('crash residue (updatedAt === endedAt) still folds to done')

  // (c) a human drag into running after the run closed -> not folded either.
  card(ledger, 'o-dragged', { sessionId: SESSION, status: 'done', at: NOW, endedAt: NOW, updatedAt: NOW })
  clock = NOW + 3_000
  ledger.applyRequest('o-drag-1', { kind: 'move', taskId: 'o-dragged', status: 'running' })
  clock = NOW + 4_000
  assert.equal(ledger.finalizeReadyRuns(), false, 'the recovery pass reverted a manual drag')
  assert.equal(statusOf(ledger, 'o-dragged'), 'running')
  line('manual drag into running is no longer bounced back')

  // (d) the turn still settles its own card: the wrapper the loop publishes is
  //     read through readTurnEnd, and the card that stayed running closes.
  const end = readTurnEnd({ type: 'turn/end', seq: 7, time: clock, data: { turn: 1, reason: { kind: 'completed' } } })
  assert.ok(end !== undefined, 'the wrapped turn/end did not decode')
  // Negative: the payload lives under `data`, so an event carrying turn/reason
  // on the outside must NOT decode (that mismatch is what left cards running).
  assert.equal(readTurnEnd({ type: 'turn/end', seq: 7, time: clock, data: {} }), undefined)
  clock = NOW + 5_000
  binder.afterTurn(SESSION, end.turn, end.reason)
  assert.equal(statusOf(ledger, 'o-bound'), 'done')
  line('turn/end -> afterTurn -> done, on the card the binding moved')
  assert.equal(statusOf(ledger, 'o-dragged'), 'running', 'another card was settled by this turn')
  ledger.dispose()
}

// --- Q: the idle fallback reads the newest turn/end from the log itself ------
{
  // This is the settle trigger that does not depend on event DELIVERY: when the
  // `turn/end` event never reaches the listener, the agent going idle still
  // knows its own log.
  const log = [
    { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'assistant/message', seq: 3, time: 3, data: {} },
    { type: 'turn/end', seq: 4, time: 4, data: { turn: 2, reason: { kind: 'error' } } },
  ]
  assert.deepEqual(lastTurnEndOf({ log }), { turn: 2, reason: { kind: 'error' } })
  assert.equal(lastTurnEndOf({ log: [] }), undefined)
  assert.equal(lastTurnEndOf(undefined), undefined)
  assert.equal(lastTurnEndOf({ log: [{ type: 'turn/start', data: { turn: 9 } }] }), undefined)
  // An undecodable entry is skipped instead of stopping the backwards scan.
  assert.deepEqual(
    lastTurnEndOf({ log: [...log, { type: 'turn/end', data: { reason: { kind: 'aborted' } } }] }),
    { turn: 2, reason: { kind: 'error' } },
  )
  line('idle fallback reads the newest turn/end from the log', lastTurnEndOf({ log }))
}

// --- P: a turn may not settle while its session still has busy subagents -----
// The tree is read from session headers (`parentSession`), so it works at every
// depth; `root` itself is never counted (it is the agent whose turn just ended).
{
  const agent = (sessionId: string, parentSession: string | undefined, busy: boolean): LiveAgentState =>
    ({ sessionId, ...(parentSession === undefined ? {} : { parentSession }), busy })

  // parent idle + child busy
  assert.equal(hasBusyDescendant('p', [agent('p', undefined, false), agent('c', 'p', true)]), true)
  line('parent idle + one busy child -> true')

  // the child going idle releases the settle
  assert.equal(hasBusyDescendant('p', [agent('p', undefined, false), agent('c', 'p', false)]), false)
  line('same tree, child now idle -> false (the settle may proceed)')

  // multi-level: the grandchild is what keeps it busy
  assert.equal(
    hasBusyDescendant('p', [agent('p', undefined, false), agent('c', 'p', false), agent('gc', 'c', true)]),
    true,
  )
  line('grandchild busy -> true (multi-level, not just direct children)')

  // unrelated busy agents do not hold this session's card
  assert.equal(
    hasBusyDescendant('p', [agent('p', undefined, false), agent('other', 'elsewhere', true), agent('c', 'p', false)]),
    false,
  )
  line('a busy agent outside the subtree -> false')

  // root's own busy flag is not counted (the question is asked at its turn end)
  assert.equal(hasBusyDescendant('p', [agent('p', undefined, true)]), false)
  line('root busy, no children -> false (root excluded)')

  // CYCLES: a corrupted header pointing back at an ancestor must not hang.
  // (a) child claims root as its parent -> already visited, terminates.
  assert.equal(hasBusyDescendant('p', [agent('p', 'c', false), agent('c', 'p', true)]), true)
  // (b) two rows pointing at each other, nobody busy -> terminates, false.
  assert.equal(hasBusyDescendant('p', [agent('c', 'p', false), agent('p', 'c', false)]), false)
  // (c) a descendant naming ITSELF as parent -> terminates.
  assert.equal(hasBusyDescendant('p', [agent('p', undefined, false), agent('c', 'c', true)]), false)
  // (d) a 3-node ring with one busy member -> still found, still terminates.
  assert.equal(hasBusyDescendant('p', [agent('p', 'g', false), agent('c', 'p', false), agent('g', 'c', true)]), true)
  line('cycles (root<->child, self-parent, 3-node ring) terminate with a sane answer')

  // Duplicates are merged pessimistically: a stale idle record can never be
  // what lets a card settle early.
  assert.equal(hasBusyDescendant('p', [agent('c', 'p', false), agent('c', 'p', true)]), true)
  line('duplicate rows: any busy report wins -> true')

  // Degenerate inputs.
  assert.equal(hasBusyDescendant('', [agent('c', 'p', true)]), false)
  assert.equal(hasBusyDescendant('p', []), false)
  line('empty root / empty tree -> false')
}

process.stdout.write('\nsession-binding: all checks passed\n')

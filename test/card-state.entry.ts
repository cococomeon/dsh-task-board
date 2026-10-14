/**
 * Real-path checks for the live session state a task card reports.
 *
 * A card's column and execution record only say the runner owns the card; what
 * the run is doing right now (working, blocked on an approval, blocked on a
 * question, or stopped with nothing acknowledged) comes from the Session UI
 * service. Everything here drives the actual modules that render it — the pure
 * translation in core/session-state.ts, the card derivation in
 * client/board/card-view.ts, and the controller's no-op-on-equal push rule —
 * so the precedence, the "only an owned card shows a live state" gate and the
 * memo-friendly equality are pinned by executable evidence rather than by
 * reading the renderer.
 *
 * Usage: node test/run.mjs test/card-state.entry.ts
 */
import assert from 'node:assert/strict'
import { BoardController } from '../src/core/controller.ts'
import { collectSessionRuntimeStates, sameSessionRuntimeStates, sessionRuntimeState, type SessionRuntimeState } from '../src/core/session-state.ts'
import { cardRuntimeState } from '../src/client/board/card-view.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import type { TaskStore } from '../src/core/store.ts'

const NOW = 1_760_000_000_000
const RUNNING_SESSION = 'session-11111111-2222-3333-4444-555555555555'
const SETTLED_SESSION = 'session-99999999-8888-7777-6666-555555555555'

const print = (label: string, value: unknown): void => {
  console.log(`${label}: ${value === undefined ? '(none)' : JSON.stringify(value)}`)
}

// --- A: the status -> token translation -------------------------------------
{
  assert.equal(sessionRuntimeState(undefined), undefined)
  print('A1 no status', sessionRuntimeState(undefined))

  // Precedence: a pending interaction outranks the running flag it sits next to.
  assert.equal(sessionRuntimeState({ running: true, pendingInteraction: { kind: 'approval' } }), 'approval')
  print('A2 approval beats running', sessionRuntimeState({ running: true, pendingInteraction: { kind: 'approval' } }))

  assert.equal(sessionRuntimeState({ running: true, pendingInteraction: { kind: 'question' } }), 'question')
  print('A3 question beats running', sessionRuntimeState({ running: true, pendingInteraction: { kind: 'question' } }))

  // A domain this build does not know still blocks on a human: it must read as
  // "waiting for you", never as work in progress.
  assert.equal(sessionRuntimeState({ running: true, pendingInteraction: { kind: 'plan-review' } }), 'question')
  print('A4 unknown domain', sessionRuntimeState({ running: true, pendingInteraction: { kind: 'plan-review' } }))

  // running outranks the stop flag, which is only meaningful once work stopped.
  assert.equal(sessionRuntimeState({ running: true, completionUnread: true }), 'running')
  print('A5 running beats unread stop', sessionRuntimeState({ running: true, completionUnread: true }))

  assert.equal(sessionRuntimeState({ running: false, completionUnread: true }), 'stopped')
  print('A6 stopped and unread', sessionRuntimeState({ running: false, completionUnread: true }))

  // Idle — and a status whose running flag is not established yet — reports
  // nothing, so the card keeps its execution-derived label instead of claiming
  // a state nobody knows.
  assert.equal(sessionRuntimeState({ running: false }), undefined)
  assert.equal(sessionRuntimeState({}), undefined)
  print('A7 idle / unknown running', sessionRuntimeState({ running: false }))
}

// --- B: the snapshot projection ---------------------------------------------
{
  const states = collectSessionRuntimeStates([
    ['s-idle', { running: false }],
    ['s-work', { running: true }],
    ['s-approval', { pendingInteraction: { kind: 'approval' } }],
    ['s-stop', { completionUnread: true }],
  ])
  assert.deepEqual([...states].sort(), [['s-approval', 'approval'], ['s-stop', 'stopped'], ['s-work', 'running']])
  print('B1 projected map', [...states].sort())

  assert.equal(sameSessionRuntimeStates(states, new Map(states)), true)
  assert.equal(sameSessionRuntimeStates(states, new Map([...states, ['s-work', 'stopped']])), false)
  assert.equal(sameSessionRuntimeStates(states, new Map([...states].slice(1))), false)
  print('B2 equal maps are equal', sameSessionRuntimeStates(states, new Map(states)))
}

// --- C: which card may report a live state ----------------------------------
{
  const open: ExecutionRecord = { id: 'e1', sessionId: RUNNING_SESSION, startedAt: NOW, endedAt: undefined, result: undefined, error: undefined }
  const settled: ExecutionRecord = { ...open, id: 'e2', endedAt: NOW + 1_000, result: 'succeeded' }
  const task = (patch: Partial<TaskRecord>): TaskRecord => ({
    ...createTask({ title: 't', description: 'd', prompt: 'p' }, NOW, 'c1'),
    ...patch,
  })
  const live = new Map<string, SessionRuntimeState>([
    [RUNNING_SESSION, 'running'],
    [SETTLED_SESSION, 'stopped'],
  ])

  const owned = task({ executions: [open] })
  assert.equal(cardRuntimeState(owned, live, false), 'running')
  print('C1 owned card reports its session state', cardRuntimeState(owned, live, false))

  // The same session can be reused by a later run: a settled card must not
  // inherit what that session is doing now.
  const done = task({ status: 'done', executions: [settled] })
  assert.equal(cardRuntimeState(done, live, false), undefined)
  print('C2 settled card reports nothing', cardRuntimeState(done, live, false))

  assert.equal(cardRuntimeState(owned, live, true), undefined)
  print('C3 archived card reports nothing', cardRuntimeState(owned, live, true))

  // No runtime face at all (a shell-less host) and no linked session: both
  // leave the card on its historical label instead of failing.
  assert.equal(cardRuntimeState(owned, undefined, false), undefined)
  assert.equal(cardRuntimeState(task({ executions: [{ ...open, sessionId: undefined }] }), live, false), undefined)
  print('C4 no runtime face / no session', cardRuntimeState(owned, undefined, false))
}

// --- D: the controller carries the map and ignores an equal push ------------
{
  let saves = 0
  const store: TaskStore = {
    load: () => [],
    save: () => { saves += 1 },
    clear: () => {},
  }
  const controller = new BoardController({
    store,
    sessions: { current: () => undefined, open: () => {}, subscribe: () => () => {} },
  })
  controller.start()

  // A subscriber stands in for the board's React subscription: an equal push
  // must not notify, or every session-status frame would re-render every card.
  let notifications = 0
  const unsubscribe = controller.subscribe(() => { notifications += 1 })

  controller.setSessionStates(new Map<string, SessionRuntimeState>([[RUNNING_SESSION, 'running']]))
  const afterFirst = notifications
  controller.setSessionStates(new Map<string, SessionRuntimeState>([[RUNNING_SESSION, 'running']]))
  assert.equal(notifications, afterFirst)
  controller.setSessionStates(new Map<string, SessionRuntimeState>([[RUNNING_SESSION, 'approval']]))
  assert.equal(notifications, afterFirst + 1)
  print('D1 pushes -> notifications', notifications)

  assert.equal(controller.getSnapshot().sessionStates?.get(RUNNING_SESSION), 'approval')
  print('D2 snapshot carries the map', controller.getSnapshot().sessionStates?.get(RUNNING_SESSION))
  assert.equal(saves, 0)
  unsubscribe()
  controller.dispose()
}

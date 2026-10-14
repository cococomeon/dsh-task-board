/**
 * Real-path checks for the browser half of "card <-> session" linking: which
 * session a card links to, and the one state machine that turns a pointer click
 * into either the detail or a session jump.
 *
 * Everything here drives the actual modules the card renders from (bundled by
 * test/run.mjs). The synthetic task records are minted by the real `createTask`,
 * so the shape under test is the shape the ledger produces — the running Host
 * has not been restarted, so no real card carries `createdBySessionId` yet.
 *
 * Usage: node test/run.mjs test/card-link.entry.ts
 */
import assert from 'node:assert/strict'
import { CARD_DOUBLE_CLICK_MS, createCardActivation, type CardActivationClock } from '../src/client/board/card-activation.ts'
import { cardSessionId } from '../src/client/board/card-view.ts'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'

const NOW = 1_760_000_000_000
const SESSION = 'session-84a09234-1111-2222-3333-444455556666'
const OTHER = 'session-11111111-2222-3333-4444-555555555555'

const execution = (id: string, sessionId: string | undefined, startedAt: number): ExecutionRecord => ({
  id,
  sessionId,
  startedAt,
  endedAt: startedAt + 1_000,
  result: 'succeeded',
  error: undefined,
})

/** A task record as the real producer mints it, with the parts under test replaced. */
const synthetic = (id: string, patch: Partial<TaskRecord> = {}, createdBySessionId?: string): TaskRecord => ({
  ...createTask({ title: id, description: 'd', prompt: 'p', ...(createdBySessionId === undefined ? {} : { createdBySessionId }) }, NOW, id),
  ...patch,
})

const print = (label: string, value: string | undefined): void => {
  console.log(`${label}: ${value === undefined ? '(none)' : value}`)
}

// --- A: the resolution rule (last run WITH a session, else the creating one) ---
{
  const onlyRun = synthetic('a1', { executions: [execution('e1', SESSION, NOW)] })
  assert.equal(cardSessionId(onlyRun), SESSION)
  print('A1 only execution session', cardSessionId(onlyRun))

  const trailingNoSession = synthetic('a2', {
    executions: [execution('e1', SESSION, NOW), execution('e2', undefined, NOW + 10)],
  })
  assert.equal(cardSessionId(trailingNoSession), SESSION)
  print('A2 last execution has no session -> earlier one', cardSessionId(trailingNoSession))

  const created = synthetic('a3', {}, SESSION)
  assert.equal(cardSessionId(created), SESSION)
  print('A3 no executions -> createdBySessionId', cardSessionId(created))

  const bare = synthetic('a4')
  assert.equal(cardSessionId(bare), undefined)
  print('A4 neither', cardSessionId(bare))

  const both = synthetic('a5', { executions: [execution('e1', SESSION, NOW)] }, OTHER)
  assert.equal(cardSessionId(both), SESSION)
  print('A5 both present -> execution session wins', cardSessionId(both))

  // A blank is not a link: the card must not offer a control that navigates
  // nowhere. createTask drops a blank creating session at the source.
  const blankCreated = synthetic('a6', {}, '   ')
  assert.equal(blankCreated.createdBySessionId, undefined)
  const blankRun = synthetic('a7', { executions: [execution('e1', '   ', NOW)] }, SESSION)
  assert.equal(cardSessionId(blankRun), SESSION)
  print('A6 blank creating session normalised away', blankCreated.createdBySessionId)
  print('A7 blank execution session falls back', cardSessionId(blankRun))
}

// --- B: the double-click state machine ---------------------------------------
{
  const fakeClock = (): { clock: CardActivationClock; advance: (ms: number) => void; pending: () => number } => {
    let now = 0
    let nextId = 1
    const timers = new Map<number, { due: number; fn: () => void }>()
    return {
      clock: {
        set: (fn, ms) => {
          const id = nextId++
          timers.set(id, { due: now + ms, fn })
          return id
        },
        clear: (handle) => { timers.delete(handle as number) },
      },
      advance: (ms) => {
        now += ms
        for (const [id, timer] of [...timers]) {
          if (timer.due > now) continue
          timers.delete(id)
          timer.fn()
        }
      },
      pending: () => timers.size,
    }
  }
  const harness = (): { calls: string[]; click: (sessionId: string | undefined) => void; activate: () => void; cancel: () => void; advance: (ms: number) => void; pending: () => number } => {
    const calls: string[] = []
    const { clock, advance, pending } = fakeClock()
    const activation = createCardActivation({
      openDetail: () => { calls.push('detail') },
      openSession: (sessionId) => { calls.push(`session:${sessionId}`) },
      notifyNoSession: () => { calls.push('notice') },
    }, clock)
    return { calls, click: activation.click, activate: activation.activate, cancel: activation.cancel, advance, pending }
  }

  assert.equal(CARD_DOUBLE_CLICK_MS, 250)
  console.log(`B0 window = ${CARD_DOUBLE_CLICK_MS}ms`)

  const single = harness()
  single.click(SESSION)
  single.advance(CARD_DOUBLE_CLICK_MS - 1)
  assert.deepEqual(single.calls, [])
  single.advance(1)
  assert.deepEqual(single.calls, ['detail'])
  single.advance(1_000)
  assert.deepEqual(single.calls, ['detail'])
  console.log('B1 single click -> detail exactly once after the window:', JSON.stringify(single.calls))

  const pair = harness()
  pair.click(SESSION)
  pair.advance(100)
  pair.click(SESSION)
  assert.deepEqual(pair.calls, [`session:${SESSION}`])
  pair.advance(1_000)
  assert.deepEqual(pair.calls, [`session:${SESSION}`])
  assert.equal(pair.pending(), 0)
  console.log('B2 second click inside the window -> jump once, no detail:', JSON.stringify(pair.calls))

  const apart = harness()
  apart.click(SESSION)
  apart.advance(CARD_DOUBLE_CLICK_MS + 50)
  apart.click(SESSION)
  apart.advance(CARD_DOUBLE_CLICK_MS)
  assert.deepEqual(apart.calls, ['detail', 'detail'])
  console.log('B3 clicks farther apart than the window -> two details:', JSON.stringify(apart.calls))

  const keyboard = harness()
  keyboard.click(SESSION)
  keyboard.activate()
  assert.deepEqual(keyboard.calls, ['detail'])
  assert.equal(keyboard.pending(), 0)
  keyboard.advance(1_000)
  assert.deepEqual(keyboard.calls, ['detail'])
  console.log('B4 keyboard activation -> immediate detail, pending window dropped:', JSON.stringify(keyboard.calls))

  const keyboardOnly = harness()
  keyboardOnly.activate()
  assert.deepEqual(keyboardOnly.calls, ['detail'])
  console.log('B5 keyboard activation alone ->', JSON.stringify(keyboardOnly.calls))

  const noSession = harness()
  noSession.click(undefined)
  noSession.advance(100)
  noSession.click(undefined)
  assert.deepEqual(noSession.calls, ['notice'])
  noSession.advance(1_000)
  assert.deepEqual(noSession.calls, ['notice'])
  console.log('B6 double click without a session -> notice, never a jump or a detail:', JSON.stringify(noSession.calls))

  const noSessionSingle = harness()
  noSessionSingle.click(undefined)
  noSessionSingle.advance(CARD_DOUBLE_CLICK_MS)
  assert.deepEqual(noSessionSingle.calls, ['detail'])
  console.log('B7 single click without a session -> still the detail:', JSON.stringify(noSessionSingle.calls))

  const cancelled = harness()
  cancelled.click(SESSION)
  cancelled.cancel()
  cancelled.advance(1_000)
  assert.deepEqual(cancelled.calls, [])
  console.log('B8 cancel (card unmounted) -> nothing fires:', JSON.stringify(cancelled.calls))
}

console.log('ALL CHECKS PASSED')

/**
 * Real-path checks for the browser half's REVERSE card <-> session link: given
 * one session, which cards belong to it, in what order, and what a click on the
 * title-bar button must do.
 *
 * Everything below drives the actual module the button renders from
 * (`src/client/session-cards.ts`), bundled by test/run.mjs. The synthetic
 * records are minted by the real `createTask`, so the shape under test is the
 * shape the ledger produces rather than a hand-written stand-in.
 *
 * Usage: node test/run.mjs test/session-board-link.entry.ts
 */
import assert from 'node:assert/strict'
import { createTask, type ExecutionRecord, type TaskRecord } from '../src/core/tasks.ts'
import { resolveSessionLink, sessionLinkedCards } from '../src/client/session-cards.ts'

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
const card = (id: string, patch: Partial<TaskRecord> = {}, createdBySessionId?: string): TaskRecord => ({
  ...createTask({ title: id, description: 'd', prompt: 'p', ...(createdBySessionId === undefined ? {} : { createdBySessionId }) }, NOW, id),
  ...patch,
})

const ids = (cards: readonly { task: TaskRecord }[]): string[] => cards.map(entry => entry.task.id)
const line = (label: string, value: unknown): void => { console.log(`${label}: ${JSON.stringify(value)}`) }

// --- association ---------------------------------------------------------

// One execution ran in this session; the card was created from nowhere.
const ranOnly = card('ran-only', { executions: [execution('e1', SESSION, NOW + 5_000)] })
assert.deepEqual(ids(sessionLinkedCards([ranOnly], SESSION)), ['ran-only'])
line('execution-only association', sessionLinkedCards([ranOnly], SESSION))

// Several attempts in the SAME session still mean one card, not two rows.
const twice = card('twice', {
  executions: [execution('e1', SESSION, NOW + 1_000), execution('e2', OTHER, NOW + 9_000), execution('e3', SESSION, NOW + 3_000)],
})
const twiceCards = sessionLinkedCards([twice], SESSION)
assert.equal(twiceCards.length, 1)
// The latest matching run (NOW+3_000), not the later run of another session.
assert.equal(twiceCards[0]?.linkedAt, NOW + 3_000)
assert.equal(twiceCards[0]?.viaCreatedBy, false)
line('repeated executions -> one card, newest matching run', twiceCards)

// Provenance only: no execution of this card ever ran in this session.
const createdOnly = card('created-only', { executions: [] }, SESSION)
const createdCards = sessionLinkedCards([createdOnly], SESSION)
assert.equal(createdCards[0]?.viaExecution, false)
assert.equal(createdCards[0]?.viaCreatedBy, true)
// A creation link has no run time, so the card's own creation instant orders it.
assert.equal(createdCards[0]?.linkedAt, createdOnly.createdAt)
line('createdBy-only association', createdCards)

// Both reasons hold -> both must be reported, and the run time still wins.
const both = card('both', { executions: [execution('e1', SESSION, NOW + 7_000)] }, SESSION)
const bothCards = sessionLinkedCards([both], SESSION)
assert.equal(bothCards[0]?.viaExecution, true)
assert.equal(bothCards[0]?.viaCreatedBy, true)
assert.equal(bothCards[0]?.linkedAt, NOW + 7_000)
line('both reasons -> both flags', bothCards)

// An unrelated session sees nothing, even though every card carries a session.
const foreign = card('foreign', { executions: [execution('e1', OTHER, NOW)] }, OTHER)
assert.deepEqual(sessionLinkedCards([ranOnly, createdOnly, foreign], OTHER), sessionLinkedCards([foreign], OTHER))
assert.deepEqual(ids(sessionLinkedCards([ranOnly, createdOnly, foreign], OTHER)), ['foreign'])
line('unrelated session', sessionLinkedCards([ranOnly, createdOnly, foreign], OTHER))

// Empty / missing / unlistable session ids never match anything.
for (const empty of [undefined, '', '   ']) {
  assert.deepEqual(sessionLinkedCards([ranOnly, createdOnly], empty), [])
}
line('empty session id -> []', sessionLinkedCards([ranOnly, createdOnly], undefined))
line('blank session id -> []', sessionLinkedCards([ranOnly, createdOnly], '   '))

// A card whose execution carries no session id yet cannot claim one.
const unresolved = card('unresolved', { executions: [execution('e1', undefined, NOW)] })
assert.deepEqual(sessionLinkedCards([unresolved], SESSION), [])
line('execution without sessionId', sessionLinkedCards([unresolved], SESSION))

// Archived cards are off-board, so the button must not offer them.
const archived = card('archived', { executions: [execution('e1', SESSION, NOW)], archivedAt: NOW })
assert.deepEqual(sessionLinkedCards([archived], SESSION), [])
line('archived card excluded', sessionLinkedCards([archived], SESSION))

// --- ordering ------------------------------------------------------------

const order = [
  // Association at NOW+1_000, but the OLDEST updatedAt: the association time wins.
  card('a-old-assoc-new-update', {
    executions: [execution('e1', SESSION, NOW + 1_000)],
    updatedAt: NOW + 100_000,
  }),
  card('b-newest-assoc', { executions: [execution('e1', SESSION, NOW + 9_000)], updatedAt: NOW }),
  // Same association instant as c: the tie-break is updatedAt descending.
  card('c-tie-stale', { executions: [execution('e1', SESSION, NOW + 5_000)], updatedAt: NOW + 1 }),
  card('d-tie-fresh', { executions: [execution('e1', SESSION, NOW + 5_000)], updatedAt: NOW + 2 }),
  // Creation-only: ordered by createdAt (NOW from createTask) -> last.
  card('e-created-only', { executions: [] }, SESSION),
]
const ordered = sessionLinkedCards(order, SESSION)
assert.deepEqual(ids(ordered), [
  'b-newest-assoc',
  'd-tie-fresh',
  'c-tie-stale',
  'a-old-assoc-new-update',
  'e-created-only',
])
line('ordering (linkedAt desc, updatedAt desc)', ids(ordered))

// Same association instant AND same updatedAt: id ascending keeps it stable.
const stable = [
  card('zzz', { executions: [execution('e1', SESSION, NOW + 4_000)], updatedAt: NOW + 4_000 }),
  card('aaa', { executions: [execution('e1', SESSION, NOW + 4_000)], updatedAt: NOW + 4_000 }),
]
assert.deepEqual(ids(sessionLinkedCards(stable, SESSION)), ['aaa', 'zzz'])
assert.deepEqual(ids(sessionLinkedCards([...stable].reverse(), SESSION)), ['aaa', 'zzz'])
line('id tie-break is order-independent', ids(sessionLinkedCards([...stable].reverse(), SESSION)))

// --- click decision ------------------------------------------------------

const none = resolveSessionLink([foreign], SESSION)
assert.equal(none.mode, 'none')
assert.deepEqual(none.cards, [])
assert.equal(none.target, undefined)
line('mode: no card', none)

const one = resolveSessionLink([ranOnly, foreign], SESSION)
assert.equal(one.mode, 'jump')
assert.equal(one.target?.id, 'ran-only')
assert.equal(one.cards.length, 1)
line('mode: exactly one card jumps directly', { mode: one.mode, target: one.target?.id })

const many = resolveSessionLink(order, SESSION)
assert.equal(many.mode, 'choose')
assert.equal(many.target, undefined)
assert.equal(many.cards.length, 5)
line('mode: several cards open the picker', { mode: many.mode, count: many.cards.length })

// The boundary is exactly 2: still a choice, never an automatic pick.
const two = resolveSessionLink([ranOnly, createdOnly], SESSION)
assert.equal(two.mode, 'choose')
line('mode: two cards is already a choice', { mode: two.mode, count: two.cards.length })

// A card that stops being associated returns the button to the disabled state.
assert.equal(resolveSessionLink([ranOnly, crossOther()], SESSION).mode, 'jump')
function crossOther(): TaskRecord {
  return card('cross', { executions: [execution('e1', OTHER, NOW)] }, OTHER)
}

console.log('\nsession-board-link: all checks passed')

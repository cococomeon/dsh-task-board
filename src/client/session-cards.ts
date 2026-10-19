/**
 * The reverse direction of the card <-> session link: which cards a session is
 * associated with, and what clicking the header button must do.
 *
 * `cardSessionId` (board/card-view.ts) answers "which session does this card
 * point at" for one card. This module answers the mirror question for one
 * session, and it is deliberately the only place that answers it: the header
 * button, its menu and the unit tests all read this one derivation, so the
 * association rule cannot drift between them.
 *
 * Association is symmetric with the forward direction: a card belongs to
 * session S when ANY of its executions carried `sessionId === S`, or when it
 * was created from S (`createdBySessionId === S`). Both may hold at once, and
 * the card then reports both reasons.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/session-cards
 */
import type { TaskRecord } from '../core/tasks.ts'

/** One card associated with the session, with why and when. */
export interface SessionLinkedCard {
  /** The card record itself; the menu renders title and column from it. */
  task: TaskRecord
  /**
   * The association instant used for ordering: the latest execution that ran
   * in this session, or the card's creation instant when only the creation
   * link holds. This is the session's own activity time, not `updatedAt`,
   * which moves on any mutation (a drag between columns included).
   */
  linkedAt: number
  /** The card ran at least once in this session. */
  viaExecution: boolean
  /** The card was created from this session. */
  viaCreatedBy: boolean
}

/** What a click on the header button does for the current session. */
export type SessionLinkMode = 'none' | 'jump' | 'choose'

/** The resolved state: the associated cards plus the click decision. */
export interface SessionLinkState {
  /** Associated cards, most recently associated first. */
  cards: readonly SessionLinkedCard[]
  /** `none` disables the button, `jump` opens the one card, `choose` opens the menu. */
  mode: SessionLinkMode
  /** The card a `jump` opens; present exactly in `jump` mode. */
  target?: TaskRecord
}

/** An id that may arrive empty, padded, or absent from the wire. */
function normalized(id: string | undefined): string | undefined {
  if (typeof id !== 'string') return undefined
  const trimmed = id.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Read one card's association with the session.
 * @param task - the card record.
 * @param sessionId - the normalized session id to match.
 * @returns the association, or undefined when the card is unrelated.
 */
function associationOf(task: TaskRecord, sessionId: string): SessionLinkedCard | undefined {
  let latestRun: number | undefined
  for (const execution of task.executions) {
    if (normalized(execution.sessionId) !== sessionId) continue
    // Several attempts in the same session: the newest one is the moment the
    // session last touched this card, so it is what orders the menu.
    if (latestRun === undefined || execution.startedAt > latestRun) latestRun = execution.startedAt
  }
  const viaCreatedBy = normalized(task.createdBySessionId) === sessionId
  if (latestRun === undefined && !viaCreatedBy) return undefined
  return {
    task,
    linkedAt: latestRun ?? task.createdAt,
    viaExecution: latestRun !== undefined,
    viaCreatedBy,
  }
}

/**
 * Cards associated with one session, ordered for the picker.
 *
 * Ordering is total and stable: association time descending, then the card's
 * own `updatedAt` descending (an edited card is the more current one), then id
 * ascending so two cards written in the same millisecond cannot swap places
 * between renders.
 *
 * Archived cards are left out: the board is the button's destination, and an
 * archived card is not on it, so offering one would be a click that lands
 * nowhere. A session whose only link is an archived card therefore reports no
 * link.
 * @param tasks - every card the controller currently holds.
 * @param sessionId - the session to match; empty or absent yields no cards.
 * @returns associated cards, most recently associated first.
 */
export function sessionLinkedCards(
  tasks: readonly TaskRecord[],
  sessionId: string | undefined,
): SessionLinkedCard[] {
  const wanted = normalized(sessionId)
  if (wanted === undefined) return []
  const found: SessionLinkedCard[] = []
  for (const task of tasks) {
    if (task.archivedAt !== undefined) continue
    const association = associationOf(task, wanted)
    if (association !== undefined) found.push(association)
  }
  return found.sort((left, right) => right.linkedAt - left.linkedAt
    || right.task.updatedAt - left.task.updatedAt
    || (left.task.id < right.task.id ? -1 : left.task.id > right.task.id ? 1 : 0))
}

/**
 * Resolve what the header button does for one session: disabled, jump straight
 * to the single associated card, or open the picker for several.
 * @param tasks - every card the controller currently holds.
 * @param sessionId - the session to match.
 * @returns the associated cards and the click decision.
 */
export function resolveSessionLink(
  tasks: readonly TaskRecord[],
  sessionId: string | undefined,
): SessionLinkState {
  const cards = sessionLinkedCards(tasks, sessionId)
  const first = cards[0]
  if (first === undefined) return { cards, mode: 'none' }
  if (cards.length === 1) return { cards, mode: 'jump', target: first.task }
  return { cards, mode: 'choose' }
}

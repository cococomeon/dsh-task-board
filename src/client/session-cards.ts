/**
 * The reverse direction of the card <-> session link: which cards a session is
 * associated with, and what clicking the header button must do.
 *
 * `cardSessionId` (board/card-view.ts) answers "which session does this card
 * point at" for one card. This module answers the mirror question for one
 * session, and it is deliberately the only *client* place that answers it: the
 * header button, its menu and the unit tests all read this one derivation.
 *
 * The rule itself is not restated here — it lives in
 * `core/session-binding.ts`, because the Host half now asks the same question
 * before every turn (which cards this session's turn may bind) and the two
 * halves must never disagree about which cards belong to a session.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/session-cards
 */
import { sessionLinkedCards, type SessionCardAssociation } from '../core/session-binding.ts'
import type { TaskRecord } from '../core/tasks.ts'

/** One card associated with the session, with why and when. */
export type SessionLinkedCard = SessionCardAssociation

export { sessionLinkedCards }

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

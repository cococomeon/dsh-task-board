/**
 * Live runtime state of a task's session, as the browser half can see it.
 *
 * A card's column and its latest execution record only say that the runner
 * *owns* the card — not what the session behind it is doing right now. A run
 * that is blocked on an approval, one waiting for an answer, one that stopped
 * between continuation rounds, and one that is actually working all look
 * identical on the ledger. The Client Session Controller already tracks those
 * three facts per session (`running`, the highest-precedence pending
 * interaction, and the unacknowledged-stop flag); this module is the single
 * pure translation from that status into the one token a card renders, so the
 * rule is unit-testable without React or a session runtime.
 *
 * Framework-free by design: the Browser half reads the runtime service
 * structurally ({@link SessionRuntimeFacts}), so this file carries no import of
 * the SDK and a hand-built snapshot still type-checks.
 *
 * @module @linxin666/dsh-client-ui-task-board/core/session-state
 */

/**
 * What a task card reports about its session. Only states that mean something
 * to the reader are listed: an idle session with nothing pending stays
 * undefined, and the card then keeps its execution-derived label.
 */
export type SessionRuntimeState =
  /** The session is blocked on a permission approval only a human can answer. */
  | 'approval'
  /** The session is blocked on a question (including plan review) for a human. */
  | 'question'
  /** The session is executing. */
  | 'running'
  /** The session stopped and the human has not looked at it yet. */
  | 'stopped'

/** The subset of the Session UI status this module reads. */
export interface SessionRuntimeFacts {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running?: boolean
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction?: { readonly kind?: string } | undefined
  /** Whether an observed stop still needs acknowledgement. */
  readonly completionUnread?: boolean
}

/**
 * Translate one session's status into the token a card renders.
 *
 * Precedence is the order a reader cares about: a pending interaction outranks
 * running (a session awaiting an approval is not making progress, whatever the
 * running flag last said), and running outranks the stop flag (which is only
 * meaningful once the session is no longer working).
 *
 * An unknown interaction domain maps to `question` rather than to nothing: a
 * future domain that also blocks on a human must still show up as "waiting for
 * you" instead of silently reading as work in progress.
 *
 * @param facts - the session's UI status, or absence when nothing is known.
 * @returns the card token, or undefined when the session is idle.
 */
export function sessionRuntimeState(facts: SessionRuntimeFacts | undefined): SessionRuntimeState | undefined {
  if (facts === undefined) return undefined
  const kind = facts.pendingInteraction?.kind
  if (kind === 'approval') return 'approval'
  if (kind !== undefined && kind !== '') return 'question'
  if (facts.running === true) return 'running'
  if (facts.completionUnread === true) return 'stopped'
  return undefined
}

/**
 * Project a whole session-status snapshot into the id-keyed token map the
 * board holds. Sessions with nothing to report are dropped, so the map stays
 * proportional to the cards that have something to say.
 * @param source - pairs of session id and status, as the runtime publishes them.
 * @returns a fresh map of session id to token.
 */
export function collectSessionRuntimeStates(source: Iterable<readonly [string, SessionRuntimeFacts]>): Map<string, SessionRuntimeState> {
  const states = new Map<string, SessionRuntimeState>()
  for (const [sessionId, facts] of source) {
    const state = sessionRuntimeState(facts)
    if (state !== undefined) states.set(sessionId, state)
  }
  return states
}

/**
 * Whether two token maps are equal, so a repeated status frame cannot wake
 * every card on the board. Keys and values are both primitives, so an entry
 * comparison is exact.
 * @param left - the current map.
 * @param right - the incoming map.
 */
export function sameSessionRuntimeStates(
  left: ReadonlyMap<string, SessionRuntimeState>,
  right: ReadonlyMap<string, SessionRuntimeState>,
): boolean {
  if (left === right) return true
  if (left.size !== right.size) return false
  for (const [id, state] of left) {
    if (right.get(id) !== state) return false
  }
  return true
}

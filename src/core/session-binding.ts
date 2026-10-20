/**
 * The one derivation of "which cards belong to this session, and which of them
 * may be bound to the running turn".
 *
 * The board already answers the association question for the session header
 * button (`client/session-cards.ts`). The Host half now asks the SAME question
 * before every turn, and it must answer it identically — otherwise the button
 * would offer a card the turn does not bind, or bind one the button never
 * showed. So the rule itself lives here, in one place both halves import:
 *
 * - association: any `executions[i].sessionId === session`, or
 *   `createdBySessionId === session`;
 * - ordering: latest association instant, then the card's own `updatedAt`,
 *   then id — a total, stable order so a picker never reshuffles between
 *   renders;
 * - archived cards are out (they are not on the board).
 *
 * Binding narrows that list further: a card the board already treats as
 * settled work (`verified`) or as owned by the runner (an open execution) is
 * never dragged back to `running` by a conversation turn.
 *
 * @module @linxin666/dsh-client-ui-task-board/core/session-binding
 */
import { hasOpenExecution, type TaskRecord, type TaskStatus } from './tasks.ts'

/** One card associated with a session, with why and when. */
export interface SessionCardAssociation {
  /** The card record itself. */
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

/**
 * How long a turn may wait for the user to answer the binding modal before the
 * Host proceeds on its own.
 *
 * Chosen at 12 s: long enough that a user who is already looking at the screen
 * can read the card titles and click, short enough that a user who walked away
 * (or an automated client that renders no modal) loses a bounded fragment of
 * one turn instead of feeling hung. The whole budget is spent at most once per
 * turn, because the turn is processed once.
 */
export const BINDING_WAIT_MS = 12_000

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
function associationOf(task: TaskRecord, sessionId: string): SessionCardAssociation | undefined {
  let latestRun: number | undefined
  for (const execution of task.executions) {
    if (normalized(execution.sessionId) !== sessionId) continue
    // Several attempts in the same session: the newest one is the moment the
    // session last touched this card, so it is what orders the list.
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
 * Cards associated with one session, on-board only, most recently associated
 * first.
 *
 * Archived cards are left out: the board is where a binding lands, and an
 * archived card is not on it.
 * @param tasks - every card the Host (or the browser mirror) holds.
 * @param sessionId - the session to match; empty or absent yields no cards.
 * @returns associated cards, most recently associated first.
 */
export function sessionLinkedCards(
  tasks: readonly TaskRecord[],
  sessionId: string | undefined,
): SessionCardAssociation[] {
  const wanted = normalized(sessionId)
  if (wanted === undefined) return []
  const found: SessionCardAssociation[] = []
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
 * Whether a turn may bind this card: it is on the board, not human-verified,
 * and the runner does not own it.
 *
 * `hasOpenExecution` is the load-bearing clause. A card with an open execution
 * belongs to the runner, which settles it from the execution's own outcome;
 * a turn that moved it would be writing a second verdict over the same work.
 * @param task - the card to judge.
 * @returns true when a conversation turn may take the card into `running`.
 */
export function canBindTask(task: TaskRecord): boolean {
  if (task.archivedAt !== undefined) return false
  if (task.status === 'verified') return false
  return !hasOpenExecution(task)
}

/**
 * The candidates a session's turn may bind, ordered for the modal.
 * @param tasks - every card the Host holds.
 * @param sessionId - the session whose turn is starting.
 * @returns bindable candidates, most recently associated first.
 */
export function bindingCandidates(
  tasks: readonly TaskRecord[],
  sessionId: string | undefined,
): SessionCardAssociation[] {
  return sessionLinkedCards(tasks, sessionId).filter(card => canBindTask(card.task))
}

/**
 * The column a turn's ending implies for the card it took into `running`.
 *
 * The Host reads `TurnEndReason.kind` from the session log; this maps it onto
 * the board's two settle columns. `completed` is the only kind that means the
 * turn finished its work. Everything else is a real failure to report:
 * `error`, `aborted` (user cancel or parent/hook cancel), `interrupted` (crash
 * orphan), `blocked` (the step was rejected before it ran), `max-tokens` (the
 * step ran out of output budget) and `forked` (a fork closed an open turn).
 * The union is merge-extensible upstream, so an unknown kind also reads as a
 * failure: a card must never be reported as finished on a reason nobody
 * recognizes.
 * @param kind - the reason's discriminant.
 * @returns the settle column.
 */
export function settleStatusOf(kind: string): TaskStatus {
  return kind === 'completed' ? 'done' : 'failed'
}

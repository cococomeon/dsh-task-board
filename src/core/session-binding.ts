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
 * Binding narrows that list further: a card the runner owns (an open
 * execution) is never dragged back to `running` by a conversation turn.
 *
 * A human-verified card is deliberately NOT excluded: continuing the
 * conversation means the work is not settled after all, and the turn's own
 * ending moves the card on from `running`, so the `verified` seal is released
 * by the same gesture that reopens the work.
 *
 * @module @linxin666/dsh-client-ui-task-board/core/session-binding
 */
import { hasOpenExecution, settledStatus, type TaskRecord, type TaskStatus } from './tasks.ts'

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
 * Whether a turn may bind this card: it is on the board and the runner does not
 * own it.
 *
 * `hasOpenExecution` is the load-bearing clause. A card with an open execution
 * belongs to the runner, which settles it from the execution's own outcome;
 * a turn that moved it would be writing a second verdict over the same work.
 *
 * A `verified` card is bindable on purpose: continuing the conversation in its
 * session means the work is not actually settled, and the turn's ending moves
 * the card on from `running`, so the verification seal is released by the same
 * gesture that reopens the work.
 * @param task - the card to judge.
 * @returns true when a conversation turn may take the card into `running`.
 */
export function canBindTask(task: TaskRecord): boolean {
  if (task.archivedAt !== undefined) return false
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
 * The board's rule is that a card follows its LATEST EXECUTION: a run is the
 * only thing that ever produced a real verdict, and a conversation turn is not
 * one. A turn that ends `aborted` (the user pressed stop, a parent cancelled),
 * `blocked`, `max-tokens` or `interrupted` says nothing about the work — while
 * `succeeded`/`failed` in the execution history says everything. Writing
 * `failed` from the turn alone is what left re-run-and-succeeded cards sitting
 * in the failed column.
 *
 * So, in order:
 *
 * 1. a latest execution with a real verdict (`succeeded` / `failed`) decides,
 *    through {@link settledStatus} — the ONE place that maps an outcome to a
 *    column, so a succeeded card with an armed schedule still lands in `todo`;
 * 2. with no verdict on record, `completed` means the turn finished its work
 *    (`done`) and `error` means it broke (`failed`);
 * 3. any other kind is neither: `aborted` (user cancel, parent or hook
 *    cancel), `blocked`, `max-tokens`, `interrupted`, `forked`, or a kind this
 *    build does not know. Those roll the card back to `from`, the column it
 *    held before this turn took it — a cancelled turn is not a failed one;
 * 4. `undefined` (no reason to read at all) with nothing on record still reads
 *    as `failed`: an ending nobody can name must not look like success.
 *
 * A `cancelled` execution record is not a verdict either (the runner cancels
 * runs it abandoned, which is the same "nobody judged this work" fact), so it
 * falls through to the kind rules rather than deciding a column.
 * @param task - the card, read for its execution history and its schedule.
 * @param kind - the reason's discriminant, or undefined when none was recorded.
 * @param from - the column the card held before this turn bound it.
 * @returns the settle column.
 */
export function settleColumnFor(task: TaskRecord, kind: string | undefined, from: TaskStatus): TaskStatus {
  const latest = task.executions[task.executions.length - 1]
  const result = latest?.result
  if (result === 'succeeded' || result === 'failed') return settledStatus(task, result)
  if (kind === 'completed') return 'done'
  if (kind === 'error' || kind === undefined) return 'failed'
  return from
}

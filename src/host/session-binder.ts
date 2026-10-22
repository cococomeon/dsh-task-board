/**
 * Turn <-> card binding: the Host half of "every question you ask in a session
 * moves that session's card back into the running column, and the turn's own
 * ending settles it".
 *
 * WHY it hangs on `agent/pre-step` and not `turn/start`: `turn/start` is a
 * broadcast of something that already happened, so nothing can be held there.
 * `agent/pre-step` is a waterfall middleware the loop awaits BEFORE the model
 * call of every step, so awaiting inside it genuinely holds the turn — the
 * official `@deepseek-ai/dsh-api-session-controller` rejects archived sessions
 * from exactly this hook.
 *
 * The block is bounded on three sides, because a conversation must never hang
 * on a question nobody is there to answer:
 *
 * - `payload.signal` abort (the user pressed stop, the turn was cancelled)
 *   releases immediately;
 * - a wall-clock budget ({@link BINDING_WAIT_MS}) releases on its own;
 * - with no browser subscribed to the board's event stream at all there is
 *   nobody to render a modal, so the Host does not wait a single tick and takes
 *   the most recently associated card instead.
 *
 * A turn that the RUNNER drives is skipped whole. When this session is the one
 * executing a card (an open execution carries this session id), that card
 * already belongs to the runner and is settled from the execution's own
 * outcome; the session is also almost never the one the user is looking at, so
 * asking there would spend the budget on a modal nobody sees and then move an
 * unrelated historical card. The skip therefore runs BEFORE any candidate is
 * computed — no prompt, no move, and nothing to settle at turn end.
 *
 * One pass per TURN, not per step: a turn runs several steps (one model call
 * plus its tool results each), and `agent/pre-step` fires for every one of
 * them. Steps are 1-based within the turn (`dsh-agent-loop` computes
 * `step = phase.step + 1` before each pre-step), so `step === 1` is the turn's
 * first and only binding point; a turn key backstops it in case a runtime ever
 * proposes step 1 twice.
 *
 * @module dsh-task-board/host/session-binder
 */
import { randomUUID } from 'node:crypto'
import { BINDING_WAIT_MS, bindingCandidates, settleStatusOf, type SessionCardAssociation } from '../core/session-binding.ts'
import { hasOpenExecution, type TaskRecord } from '../core/tasks.ts'
import type { TaskBoardBindingCandidate, TaskBoardBindingPrompt } from '../protocol.ts'
import type { SessionChoiceStore } from './session-choice.ts'

/** The ledger face the binder reads and writes through (a real HostTaskLedger satisfies it). */
export interface BindingLedgerFace {
  allTasks(): readonly TaskRecord[]
  getTask(id: string): TaskRecord | undefined
  /** Apply one board action; the same writer every other mutation uses. */
  applyRequest(requestId: string, action: { kind: 'move'; taskId: string; status: 'running' | 'done' | 'failed' }): unknown
  /**
   * The card this session is currently RUNNING: the open execution whose
   * `sessionId` names it (host-ledger.ts `findOpenExecutionBySession`, the same
   * predicate that already gates the board's own tools).
   *
   * The binder asks the ledger instead of scanning tasks itself: "is this
   * session executing a card" must have ONE answer, and the ledger's is the one
   * the rest of the board already uses.
   */
  findOpenExecutionBySession(sessionId: string): { task: TaskRecord; execution: unknown } | undefined
}

/** What the binder needs from the running board. */
export interface SessionBinderDeps {
  ledger: BindingLedgerFace
  choices: SessionChoiceStore
  /**
   * Whether ANY browser is currently subscribed to the board's event stream.
   * A deployment with no subscriber has no surface that can answer a modal, so
   * waiting would only delay the turn.
   */
  hasSubscribers(): boolean
  /** Push the current event frame (the prompt reaches the browser through it). */
  publish(): void
  /** Clock seam; defaults to Date.now. */
  now?: () => number
  /** Id seam; defaults to randomUUID. */
  uuid?: () => string
  /** Wait budget in ms; defaults to {@link BINDING_WAIT_MS}. */
  waitMs?: number
  /** Warn sink for the wiring's logger; defaults to console.warn. */
  warn?: (message: string, ...rest: unknown[]) => void
}

/** One answer to a raised prompt. */
type Answer = { kind: 'pick'; task: SessionCardAssociation } | { kind: 'skip' }

/** The live question: what the browser shows, and how the route answers it. */
interface PendingAsk {
  prompt: TaskBoardBindingPrompt
  /** The candidates the answer is checked against (the prompt carries a projection). */
  candidates: readonly SessionCardAssociation[]
  settle: (answer: Answer | undefined) => void
}

/** A card this process moved for a turn, awaiting that turn's ending. */
interface ActedTurn {
  sessionId: string
  taskId: string
  turn: number
}

/**
 * How many finished turn keys are remembered. The dedupe exists to survive
 * repeated pre-steps of a turn that is still running; keeping a few hundred
 * covers a long session without growing without bound.
 */
const TURN_KEY_LIMIT = 400

/** Turn-end reasons the Host may observe; only `kind` is read. */
export interface TurnEndLike {
  kind: string
}

/**
 * Read the turn number and reason out of one published session log event.
 *
 * `append(type, data)` publishes `{ type, seq, time, data }`: the payload is
 * WRAPPED under `data`. Reading `turn`/`reason` off the event itself yields
 * undefined, and a settle keyed on `${sessionId}#undefined` never matches the
 * turn the binder recorded — the card then stays in `running` forever.
 * @param event - one event as the session log published it.
 * @returns the turn and its reason, or undefined for anything else.
 */
export function readTurnEnd(
  event: { type?: unknown; data?: { turn?: unknown; reason?: TurnEndLike } } | undefined,
): { turn: number; reason: TurnEndLike | undefined } | undefined {
  if (event?.type !== 'turn/end') return undefined
  const turn = event.data?.turn
  if (typeof turn !== 'number') return undefined
  return { turn, reason: event.data?.reason }
}

/**
 * The turn ending recorded last in a session's log, or undefined when it has
 * none yet.
 *
 * This is the settle trigger that does not depend on event DELIVERY: an idle
 * agent can be asked what its log says, and the loop appends `turn/end` before
 * the agent goes idle. The scan runs backwards so the newest ending wins, and an
 * event that does not decode is skipped rather than stopping the scan.
 * @param session - the session whose log to read (anything with a `log` array).
 * @returns the newest decodable `turn/end`.
 */
export function lastTurnEndOf(
  session: { log?: unknown } | undefined,
): { turn: number; reason: TurnEndLike | undefined } | undefined {
  const log = session?.log
  if (!Array.isArray(log)) return undefined
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const end = readTurnEnd(log[index] as { type?: unknown; data?: { turn?: unknown } } | undefined)
    if (end !== undefined) return end
  }
  return undefined
}

export class SessionBinder {
  private readonly deps: SessionBinderDeps
  /** Prompts currently blocking a turn, keyed by session id (one per session). */
  private readonly pending = new Map<string, PendingAsk>()
  /** Turns already bound or already considered, keyed `${sessionId}#${turn}`. */
  private readonly seenTurns = new Set<string>()
  /** Cards moved by a turn, awaiting that turn's ending. */
  private readonly acted = new Map<string, ActedTurn>()

  constructor(deps: SessionBinderDeps) {
    this.deps = deps
  }

  /** Prompts blocking right now, for the SSE frame. */
  pendingPrompts(): readonly TaskBoardBindingPrompt[] {
    return [...this.pending.values()].map(item => item.prompt)
  }

  /**
   * Bind this turn's card, if the session has any.
   *
   * Awaiting here holds the turn open — that is the point — so every path
   * through this method is bounded (see the module doc).
   * @param sessionId - the session whose turn is starting.
   * @param turn - the turn number (1-based, from the pre-step payload).
   * @param step - the step number within the turn (1-based).
   * @param signal - the turn's cancellation signal.
   */
  async beforeTurn(
    sessionId: string,
    turn: number,
    step: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    if (sessionId === '') return
    // One pass per turn: the first step is the binding point, and the turn key
    // covers a runtime that proposes step 1 more than once.
    if (step !== 1) return
    const key = `${sessionId}#${turn}`
    if (this.seenTurns.has(key)) return
    this.rememberTurn(key)

    // A runner-driven turn binds nothing: the card it is executing belongs to
    // the runner, and the session is generally not the one in front of the
    // user, so a modal here would only burn the wait budget and then move an
    // unrelated historical card. Checked before the candidate scan so a run
    // never even costs a question.
    if (this.deps.ledger.findOpenExecutionBySession(sessionId) !== undefined) return

    const candidates = bindingCandidates(this.deps.ledger.allTasks(), sessionId)
    if (candidates.length === 0) return

    let chosen: SessionCardAssociation | undefined
    if (candidates.length === 1) {
      chosen = candidates[0]
    } else {
      // The remembered answer outranks asking again, but only while the card it
      // names is still a candidate: a deleted, archived, verified or
      // runner-owned card invalidates the memory and the user is asked afresh.
      const remembered = this.deps.choices.get(sessionId)
      chosen = remembered === undefined ? undefined : candidates.find(card => card.task.id === remembered)
      if (chosen === undefined) {
        // Nothing to ask WITHOUT a surface: a browser-less deployment (an agent
        // driven from a script, a headless run) would otherwise wait out the
        // whole budget for a modal nobody draws.
        const answer = this.deps.hasSubscribers()
          ? await this.ask(sessionId, candidates, signal)
          : undefined
        if (answer?.kind === 'skip') return
        if (answer?.kind === 'pick') {
          // Only a human answer becomes sticky; a timeout or a no-subscriber
          // fallback must not silence the question for every later turn.
          this.deps.choices.set(sessionId, answer.task.task.id)
          chosen = answer.task
        } else {
          chosen = candidates[0]
        }
      }
    }
    if (chosen === undefined) return
    if (signal?.aborted === true) return
    this.move(chosen.task, 'running', key, sessionId, turn)
  }

  /**
   * Settle the card this turn moved, from the turn's own ending.
   *
   * Three re-checks before writing, all of them about not fighting the runner
   * or the user: the card must still exist, still sit in `running`, and still
   * have no open execution. A card that changed under us in this same turn
   * (dragged by hand, archived, taken over by a Host run) keeps whatever it
   * became.
   * @param sessionId - the session whose turn ended.
   * @param turn - the turn number.
   * @param reason - the recorded `TurnEndReason`.
   */
  afterTurn(sessionId: string, turn: number, reason: TurnEndLike | undefined): void {
    const key = `${sessionId}#${turn}`
    const acted = this.acted.get(key)
    if (acted === undefined) return
    this.acted.delete(key)
    const task = this.deps.ledger.getTask(acted.taskId)
    if (task === undefined || task.archivedAt !== undefined) return
    if (task.status !== 'running') return
    if (hasOpenExecution(task)) return
    const status = settleStatusOf(reason?.kind ?? 'error')
    this.move(task, status, key, sessionId, turn)
  }

  /**
   * Answer the prompt blocking one session.
   * @param sessionId - the session the answer belongs to.
   * @param taskId - the chosen card, or null for "none of these this turn".
   * @returns true when a waiting turn accepted the answer.
   */
  resolveChoice(sessionId: string, taskId: string | null): boolean {
    const ask = this.pending.get(sessionId)
    if (ask === undefined) return false
    if (taskId === null) {
      ask.settle({ kind: 'skip' })
      return true
    }
    const chosen = ask.candidates.find(card => card.task.id === taskId)
    if (chosen === undefined) return false
    ask.settle({ kind: 'pick', task: chosen })
    return true
  }

  /** Release every waiting turn (plugin unload); the turns then proceed. */
  dispose(): void {
    for (const ask of [...this.pending.values()]) ask.settle(undefined)
    this.pending.clear()
  }

  /**
   * Raise the question and wait for one of: an answer, the budget, or an abort.
   * Always resolves — an unresolved promise here would hold a turn forever.
   */
  private async ask(
    sessionId: string,
    candidates: readonly SessionCardAssociation[],
    signal: AbortSignal | undefined,
  ): Promise<Answer | undefined> {
    const now = this.now()
    const waitMs = this.deps.waitMs ?? BINDING_WAIT_MS
    const prompt: TaskBoardBindingPrompt = {
      sessionId,
      createdAt: now,
      deadlineAt: now + waitMs,
      candidates: candidates.map(candidateOf),
    }
    let settle: (answer: Answer | undefined) => void = () => {}
    const answer = new Promise<Answer | undefined>((resolve) => { settle = resolve })
    const ask: PendingAsk = { prompt, candidates, settle }
    // One question per session: a second turn cannot start while this one is
    // blocked, but a stale entry must never swallow the new prompt.
    this.pending.set(sessionId, ask)
    const timer = setTimeout(() => { settle(undefined) }, waitMs)
    const onAbort = (): void => { settle(undefined) }
    signal?.addEventListener('abort', onAbort, { once: true })
    // Tell the browser half there is a question. This is a frame, not a ledger
    // change: the ledger is untouched until the answer arrives.
    this.deps.publish()
    try {
      return await answer
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Only clear the slot when it is still this question: a later turn may
      // already have replaced it.
      if (this.pending.get(sessionId) === ask) this.pending.delete(sessionId)
      this.deps.publish()
    }
  }

  /** Move one card through the ledger, recording the action for settle. */
  private move(
    task: SessionCardAssociation['task'],
    status: 'running' | 'done' | 'failed',
    key: string,
    sessionId: string,
    turn: number,
  ): void {
    // The card is already in the column we want: no write, and no settle claim
    // either — this turn did not move it, so its ending is not ours to report.
    // KNOWN consequence, accepted deliberately: a card left in `running` by an
    // earlier turn that never ended (host crash, plugin reload) stays there
    // through this turn instead of being swept into a settle column.
    if (task.status === status) return
    try {
      this.deps.ledger.applyRequest(this.deps.uuid?.() ?? randomUUID(), { kind: 'move', taskId: task.id, status })
    } catch (error) {
      this.deps.warn?.(`task-board: session binding could not move ${task.id} to ${status}`, error)
      return
    }
    if (status === 'running') this.acted.set(key, { sessionId, taskId: task.id, turn })
    else this.acted.delete(key)
  }

  /** Remember one turn key with a bounded history. */
  private rememberTurn(key: string): void {
    this.seenTurns.add(key)
    if (this.seenTurns.size <= TURN_KEY_LIMIT) return
    const oldest = this.seenTurns.values().next().value
    if (typeof oldest === 'string') this.seenTurns.delete(oldest)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }
}

/** Project one candidate onto the wire shape the modal renders. */
function candidateOf(card: SessionCardAssociation): TaskBoardBindingCandidate {
  return {
    taskId: card.task.id,
    title: card.task.title,
    status: card.task.status,
    linkedAt: card.linkedAt,
    viaExecution: card.viaExecution,
    viaCreatedBy: card.viaCreatedBy,
  }
}

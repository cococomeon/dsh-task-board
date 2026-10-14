/**
 * Card view model: the pure derivations a task card renders from its record.
 *
 * Everything here is a function of the task record (plus the clock and the
 * Host time zone for the recency groups), so the card stays a thin renderer and
 * every rule is unit-testable without mounting React. Nothing here writes the
 * record: the type prefix, the tone and the time label are presentation only.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/board/card-view
 */
import { hasOpenExecution, type ExecutionOutcome, type ExecutionRecord, type TaskRecord, type TaskStatus } from '../../core/tasks.ts'
import type { SessionRuntimeState } from '../../core/session-state.ts'
import type { TaskBoardKey } from '../locales.ts'

/** A title split into its bracketed type prefix and the remaining text. */
export interface TitleParts {
  /** Bracketed type prefix such as `Bug` from `[Bug]: ...`; absent when none. */
  kind?: string
  /** Title text without the prefix (the whole title when there is no prefix). */
  text: string
}

/** `[Bug]:` / `[Issue]` / a bracketed CJK word, at most 24 characters, optional colon. */
const KIND_PREFIX = /^\[([^[\]\n]{1,24})\]\s*[:\uFF1A]?\s*/

/**
 * Split an issue-form style type prefix off a title. The prefix becomes a
 * badge, so the clamped title lines carry the text the reader scans for. A
 * title that is only a prefix keeps its full text.
 * @param summary - the plain-text title.
 * @returns the prefix (when present) and the remaining title text.
 */
export function splitTitleKind(summary: string): TitleParts {
  const match = KIND_PREFIX.exec(summary)
  if (match === null) return { text: summary }
  const kind = (match[1] ?? '').trim()
  const text = summary.slice(match[0].length).trim()
  if (kind === '' || text === '') return { text: summary }
  return { kind, text }
}

/** Stripe tone of a card: the state of its latest execution. */
export type CardTone = 'running' | ExecutionOutcome

/** What the card reports about its latest execution. */
export interface CardOutcome {
  /** Stripe tone; absent on an archived card or a card that never ran. */
  tone?: CardTone
  /** The latest execution record, when the card ran at least once. */
  latest?: ExecutionRecord
  /**
   * The column disagrees with the latest settled run: a card in Done whose last
   * run did not succeed, or a card in Failed whose last run succeeded. The
   * column was then set by hand or by a provider (a closed issue), and the
   * card says so instead of letting a red run count read as a contradiction.
   */
  declared: boolean
}

/**
 * Derive the card's execution outcome.
 * @param task - the task record.
 * @param archived - whether the card renders in the archive view.
 */
export function cardOutcome(task: TaskRecord, archived: boolean): CardOutcome {
  const latest = task.executions[task.executions.length - 1]
  if (latest === undefined) return { declared: false }
  if (hasOpenExecution(task)) return archived ? { latest, declared: false } : { tone: 'running', latest, declared: false }
  const result = latest.result
  if (archived || result === undefined) return { latest, declared: false }
  const declared = (task.status === 'done' && result !== 'succeeded') || (task.status === 'failed' && result === 'succeeded')
  return { tone: result, latest, declared }
}

/** Locale key of the latest settled result shown before the run count. */
export const RESULT_KEY: Record<ExecutionOutcome, TaskBoardKey> = {
  succeeded: 'card.result.succeeded',
  failed: 'card.result.failed',
  cancelled: 'card.result.cancelled',
}

/** The one time a card shows, and what that time means. */
export interface CardTimeline {
  /** Locale key with a `{time}` placeholder. */
  key: TaskBoardKey
  /** The instant (ms epoch). */
  at: number
}

/**
 * Pick the time that tells cards in the same column apart. `updatedAt` moves
 * on every provider sync, so a column of synced cards would all read
 * "updated 4m"; each column instead shows the instant its cards differ by:
 * planning columns the creation time, an executing card its start, settled
 * columns the latest run's settlement, the archive the archive time.
 * @param task - the task record.
 * @param archived - whether the card renders in the archive view.
 */
export function cardTimeline(task: TaskRecord, archived: boolean): CardTimeline {
  if (archived && task.archivedAt !== undefined) return { key: 'card.time.archived', at: task.archivedAt }
  const open = task.executions.find(execution => execution.endedAt === undefined)
  if (open !== undefined) return { key: 'card.time.started', at: open.startedAt }
  if (task.status === 'done' || task.status === 'failed') {
    const latest = task.executions[task.executions.length - 1]
    if (latest?.endedAt !== undefined) return { key: 'card.time.settled', at: latest.endedAt }
    return { key: 'card.time.updated', at: task.updatedAt }
  }
  if (task.status === 'backlog' || task.status === 'todo') return { key: 'card.time.created', at: task.createdAt }
  return { key: 'card.time.updated', at: task.updatedAt }
}

/** Recency bucket of a settled card. */
export type RecencyGroup = 'today' | 'week' | 'earlier'

/** Group order, newest first. */
export const RECENCY_GROUPS: readonly RecencyGroup[] = ['today', 'week', 'earlier']

/** Locale key of each recency group header. */
export const RECENCY_KEY: Record<RecencyGroup, TaskBoardKey> = {
  today: 'board.group.today',
  week: 'board.group.week',
  earlier: 'board.group.earlier',
}

const DAY_FORMATS = new Map<string, Intl.DateTimeFormat>()

/** Calendar day of an instant in a time zone (the browser zone when absent). */
function dayKey(ms: number, timeZone: string | undefined): string {
  const key = timeZone ?? ''
  let format = DAY_FORMATS.get(key)
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone === undefined ? {} : { timeZone }) })
    } catch {
      // An unknown zone id: bucket by the browser zone rather than failing the board.
      format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' })
    }
    DAY_FORMATS.set(key, format)
  }
  return format.format(new Date(ms))
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Bucket an instant: the same Host calendar day as now, the last seven days, or
 * earlier.
 * @param at - the instant to bucket.
 * @param now - the current instant.
 * @param timeZone - Host IANA zone the calendar day is read in.
 */
export function recencyGroup(at: number, now: number, timeZone?: string): RecencyGroup {
  if (dayKey(at, timeZone) === dayKey(now, timeZone)) return 'today'
  if (now - at < WEEK_MS) return 'week'
  return 'earlier'
}

/** One recency group and its items, newest first. */
export interface RecencyBucket<T> {
  group: RecencyGroup
  items: T[]
}

/**
 * Sort items newest first and split them into recency groups; empty groups are
 * omitted.
 * @param items - the items to group.
 * @param at - the instant each item is ordered and bucketed by.
 * @param now - the current instant.
 * @param timeZone - Host IANA zone.
 */
export function groupByRecency<T>(items: readonly T[], at: (item: T) => number, now: number, timeZone?: string): RecencyBucket<T>[] {
  const sorted = [...items].sort((left, right) => at(right) - at(left))
  const buckets = new Map<RecencyGroup, T[]>()
  for (const item of sorted) {
    const group = recencyGroup(at(item), now, timeZone)
    const list = buckets.get(group) ?? []
    list.push(item)
    buckets.set(group, list)
  }
  return RECENCY_GROUPS.filter(group => buckets.has(group)).map(group => ({ group, items: buckets.get(group)! }))
}

/**
 * The one session a card is linked to.
 *
 * The newest execution of a card may carry no session (an imported or
 * hand-settled row), so the link comes from the newest execution that has one;
 * only a card that never ran falls back to the session that created it. The
 * card's session control and its double-click both read this single result, so
 * a card can never show a session control the double-click refuses to follow.
 * @param task - the task record.
 * @returns the linked session id, or undefined when the card has none.
 */
export function cardSessionId(task: TaskRecord): string | undefined {
  for (let index = task.executions.length - 1; index >= 0; index -= 1) {
    const sessionId = task.executions[index]?.sessionId
    if (sessionId !== undefined && sessionId.trim() !== '') return sessionId
  }
  const created = task.createdBySessionId
  return created !== undefined && created.trim() !== '' ? created : undefined
}

/** Locale key of each live session state a card can report. */
export const RUNTIME_KEY: Record<SessionRuntimeState, TaskBoardKey> = {
  approval: 'card.state.approval',
  question: 'card.state.question',
  running: 'card.state.running',
  stopped: 'card.state.stopped',
}

/** Locale key of the one-line explanation behind each state badge. */
export const RUNTIME_HINT_KEY: Record<SessionRuntimeState, TaskBoardKey> = {
  approval: 'card.state.approvalHint',
  question: 'card.state.questionHint',
  running: 'card.state.runningHint',
  stopped: 'card.state.stoppedHint',
}

/**
 * The live session state a card reports, or undefined when the card has none.
 *
 * Only a card the runner currently owns is eligible: a settled card shares
 * nothing with its session's present (the same session can be reused for a
 * later run), so a stale "running" there would be a lie. Within that gate the
 * linked session's own status decides — including the case the ledger cannot
 * express, a run blocked on a human.
 * @param task - the task record.
 * @param states - live session state by session id; absent when the runtime
 * exposes none (a shell-less host, or a browser half that never subscribed).
 * @param archived - whether the card renders in the archive view.
 */
export function cardRuntimeState(
  task: TaskRecord,
  states: ReadonlyMap<string, SessionRuntimeState> | undefined,
  archived: boolean,
): SessionRuntimeState | undefined {
  if (archived || states === undefined || !hasOpenExecution(task)) return undefined
  const sessionId = cardSessionId(task)
  return sessionId === undefined ? undefined : states.get(sessionId)
}

/** Columns that render compact by default: the long settled column. */
export const DEFAULT_COMPACT_COLUMNS: readonly TaskStatus[] = ['done']

/** Browser storage key of the per-column density choice. */
export const COMPACT_COLUMNS_KEY = 'dsh.taskBoard.compactColumns.v1'

const STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'running', 'done', 'verified', 'failed']

/**
 * Read the columns the user set to compact. A missing, unreadable or malformed
 * value falls back to the default rather than failing the board.
 * @param storage - browser storage (absent outside a browser).
 */
export function readCompactColumns(storage: Pick<Storage, 'getItem'> | undefined): TaskStatus[] {
  try {
    const raw = storage?.getItem(COMPACT_COLUMNS_KEY)
    if (raw === null || raw === undefined) return [...DEFAULT_COMPACT_COLUMNS]
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return [...DEFAULT_COMPACT_COLUMNS]
    return STATUSES.filter(status => parsed.includes(status))
  } catch {
    return [...DEFAULT_COMPACT_COLUMNS]
  }
}

/**
 * Persist the compact columns; a storage failure (quota, privacy mode) only
 * loses the preference.
 * @param storage - browser storage (absent outside a browser).
 * @param columns - the compact columns.
 */
export function writeCompactColumns(storage: Pick<Storage, 'setItem'> | undefined, columns: readonly TaskStatus[]): void {
  try {
    storage?.setItem(COMPACT_COLUMNS_KEY, JSON.stringify(STATUSES.filter(status => columns.includes(status))))
  } catch {
    // Preference only: the board keeps working with the in-memory choice.
  }
}

/** Browser storage key of the folded columns the user opened in place. */
export const EXPANDED_COLUMNS_KEY = 'dsh.taskBoard.expandedColumns.v1'

/**
 * Read the folded columns the user expanded.
 *
 * The stored set is the exception rather than the state: the board folds the
 * same columns by default in every session, and only an explicit click opens
 * one, so an unreadable value falls back to "everything still folded" instead
 * of failing the board.
 * @param storage - browser storage (absent outside a browser).
 */
export function readExpandedColumns(storage: Pick<Storage, 'getItem'> | undefined): TaskStatus[] {
  try {
    const raw = storage?.getItem(EXPANDED_COLUMNS_KEY)
    if (raw === null || raw === undefined) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return STATUSES.filter(status => parsed.includes(status))
  } catch {
    return []
  }
}

/**
 * Persist the expanded folded columns; a storage failure (quota, privacy mode)
 * only loses the preference.
 * @param storage - browser storage (absent outside a browser).
 * @param columns - the expanded columns.
 */
export function writeExpandedColumns(storage: Pick<Storage, 'setItem'> | undefined, columns: readonly TaskStatus[]): void {
  try {
    storage?.setItem(EXPANDED_COLUMNS_KEY, JSON.stringify(STATUSES.filter(status => columns.includes(status))))
  } catch {
    // Preference only: the board keeps working with the in-memory choice.
  }
}

/**
 * Whether a card offers the human "verify" action.
 *
 * The ledger owns the authoritative gate (`canVerifyTask` in core/tasks.ts,
 * enforced again by the Host); this mirrors it for the card surface, so the
 * button never appears on a card the ledger would refuse: only a settled card
 * in 'done' that is not archived and has nothing executing.
 * @param task - the task record.
 */
export function canVerifyCard(task: TaskRecord): boolean {
  return task.archivedAt === undefined && task.status === 'done' && !hasOpenExecution(task)
}

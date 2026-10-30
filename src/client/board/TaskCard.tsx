/**
 * Task card: the board's column item. One pointer click opens the task detail,
 * two pointer clicks jump to the card's linked session; the detail never opens
 * on the second click of a pair, which is why a lone click waits out the
 * double-click window (card-activation.ts owns that rule). The card itself
 * never executes anything (detail holds the Run button).
 *
 * The card is an `article` with one stretched `button` rather than a button
 * itself: interactive content inside a button is invalid HTML, and the card
 * carries its own quick actions (open the execution session, a provider's
 * link such as the tracker issue). The article owns the pointer click and
 * ignores clicks that land on a quick action; the stretched open button is the
 * keyboard and accessibility target, and its click bubbles into the same
 * handler, where it opens the detail at once (a keyboard press has no second
 * click to wait for).
 *
 * Memoized: the card re-renders only when its own task record changes, so a
 * status/filter update on one card (or scrolling) never re-renders every
 * card on the board. The per-card callbacks are built with a stable task
 * reference by the board, so the memo boundary is effective.
 */
import { memo, useEffect, useMemo, useRef } from 'react'
import type { TaskRecord } from '../../core/tasks.ts'
import { executionLabel, hasOpenExecution, tagTone } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import { useTaskBoardSeats } from '../seats.tsx'
import { createCardActivation } from './card-activation.ts'
import { cardOutcome, cardSessionId, cardTimeline, canVerifyCard, RESULT_KEY, RUNTIME_HINT_KEY, RUNTIME_KEY, splitTitleKind } from './card-view.ts'
import { IconClock, IconSession } from './icons.tsx'
import { verificationRunningKey } from './status-key.ts'
import type { SessionRuntimeState } from '../../core/session-state.ts'
import css from '../board.module.css'
import { markdownExcerpt, markdownToPlainText } from './task-markdown.tsx'

/**
 * Built formatters, keyed by time zone ('' = the browser's own). Constructing
 * an Intl.DateTimeFormat is orders of magnitude more expensive than formatting
 * with one, and the board renders dozens of timestamps per SSE frame; the
 * cached formatter keeps that cost off the render path.
 */
const HOST_TIMESTAMP_FORMATS = new Map<string, Intl.DateTimeFormat>()

function hostTimestampFormat(timeZone: string | undefined): Intl.DateTimeFormat {
  const key = timeZone ?? ''
  const cached = HOST_TIMESTAMP_FORMATS.get(key)
  if (cached !== undefined) return cached
  const format = new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...(timeZone === undefined ? {} : { timeZone }),
  })
  HOST_TIMESTAMP_FORMATS.set(key, format)
  return format
}

/** Compact relative/absolute time label. */
export function formatHostTimestamp(ms: number, timeZone?: string): string {
  try {
    return hostTimestampFormat(timeZone).format(new Date(ms))
  } catch {
    // An unsupported time-zone id throws on construction: never cache it, and
    // fall back to the ISO instant for this call.
    return new Date(ms).toISOString()
  }
}

export function formatTime(ms: number, timeZone?: string): string {
  const date = new Date(ms)
  const now = Date.now()
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  if (timeZone !== undefined) return formatHostTimestamp(ms, timeZone)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Cached YYYY-MM-DD formatters, keyed by time zone ('' = the browser's own). */
const CARD_DATE_FORMATS = new Map<string, Intl.DateTimeFormat>()

/**
 * Card time label: relative within a day, otherwise the calendar date read in
 * the Host time zone (the same zone the tooltip and the detail view use), so a
 * card never shows a browser-local date beside a Host-zone tooltip.
 * @param ms - the instant.
 * @param timeZone - Host IANA zone; absent uses the browser zone.
 * @param now - the current instant.
 */
export function formatCardTime(ms: number, timeZone?: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - ms) / 60000)
  if (minutes < 1) return t('time.justNow')
  if (minutes < 60) return `${minutes}m`
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`
  const key = timeZone ?? ''
  try {
    let format = CARD_DATE_FORMATS.get(key)
    if (format === undefined) {
      format = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(timeZone === undefined ? {} : { timeZone }) })
      CARD_DATE_FORMATS.set(key, format)
    }
    return format.format(new Date(ms))
  } catch {
    // An unsupported zone id: never cached; fall back to the UTC calendar date.
    return new Date(ms).toISOString().slice(0, 10)
  }
}

function TaskCardInner({
  task,
  pending,
  timeZone,
  onClick,
  onOpenSession,
  onMissingSession,
  onVerify,
  compact = false,
  runtime,
  subtaskCount = 0,
  isSubtask = false,
  subtasksDone = 0,
  subtasksRunning = 0,
  subtasksFailed = 0,
}: {
  task: TaskRecord
  pending: boolean
  timeZone?: string
  onClick: () => void
  /**
   * Open an execution session; absent renders the session mark inert. The
   * workspace rides along so the shell unfolds that one group for the jump.
   */
  onOpenSession?: (sessionId: string, workspaceId?: string) => void
  /** A double click found no linked session; the board reports it. */
  onMissingSession?: () => void
  /** Open the human verification dialog; absent renders no verify control. */
  onVerify?: (id: string) => void
  /** Single-line density used by long settled columns. */
  compact?: boolean
  /**
   * Live state of the card's session, when the runtime reports one. Absent
   * leaves the card on its execution-derived label — which is all a host
   * without a session-status face can honestly say.
   */
  runtime?: SessionRuntimeState
  /** Direct subtasks of this card, shown as a badge (0 hides it). */
  subtaskCount?: number
  /** Whether this card is itself a subtask. */
  isSubtask?: boolean
  /** Direct subtasks already settled as done, for the roll-up badge. */
  subtasksDone?: number
  /** Direct subtasks currently running, for the roll-up badge. */
  subtasksRunning?: number
  /** Direct subtasks that failed, for the roll-up badge. */
  subtasksFailed?: number
}) {
  const { cardDecoration } = useTaskBoardSeats()
  const runs = task.executions.length
  const summary = useMemo(() => markdownToPlainText(task.title) || task.title, [task.title])
  const title = useMemo(() => splitTitleKind(summary), [summary])
  const excerpt = useMemo(() => (compact ? '' : markdownExcerpt(task.description)), [task.description, compact])
  const archived = task.archivedAt !== undefined
  // The lock is an open execution, not the column: a card parked in 'running'
  // by hand stays draggable, and an executing card never is.
  const busy = hasOpenExecution(task)
  const isDraggable = !archived && !busy && !pending
  const outcome = cardOutcome(task, archived)
  const latest = outcome.latest
  // Forced acceptance owns the running label.
  const runningKey = verificationRunningKey(latest?.verification)
  const timeline = cardTimeline(task, archived)
  const resultText = latest?.result !== undefined ? t(RESULT_KEY[latest.result]) : ''
  // One derivation for the entry and the double-click, so the two can never
  // disagree about whether this card has a session to open.
  const sessionId = cardSessionId(task)
  // The session lives in the workspace the run was pinned to; the shell unfolds
  // that group so the jumped-to row is visible instead of folded away.
  const workspaceId = task.workspaceId
  // What the session is doing right now outranks the execution-derived label:
  // "blocked on your approval" and "working" are different facts, and only the
  // session runtime knows which one holds.
  const runtimeLabel = runtime === undefined ? '' : t(RUNTIME_KEY[runtime])
  // The line under the meta row: the acceptance phase while acceptance governs
  // the run, otherwise the execution's own "still running" wording. The generic
  // wording is only a guess — with a live state badge on the card it can
  // contradict it (a blocked run is not "进行中"), so it yields to the badge
  // and the line disappears instead of arguing with it.
  const runningLabel = !archived && latest !== undefined && executionLabel(latest) === 'running'
    ? runningKey !== undefined
      ? `${t(runningKey)}…`
      : latest.ownResult !== undefined
        ? `${t('detail.subtasks.waiting')}…`
        : runtime === undefined ? `${t('detail.result.running')}…` : ''
    : ''
  const tagNames = (task.tags ?? []).map(tag => tag.name)
  // The activation sinks read the current props through a ref: a re-render
  // (an SSE snapshot, a status change) must not rebuild the 250ms window, or a
  // slow double click would fall through and open the detail instead.
  const sinks = useRef({ openDetail: onClick, openSession: onOpenSession, notifyNoSession: onMissingSession })
  sinks.current = { openDetail: onClick, openSession: onOpenSession, notifyNoSession: onMissingSession }
  const activation = useMemo(() => createCardActivation({
    openDetail: () => { sinks.current.openDetail() },
    openSession: session => { sinks.current.openSession?.(session, workspaceId) },
    notifyNoSession: () => { sinks.current.notifyNoSession?.() },
  }), [])
  // A window must not outlive its card: the board filters, folds and re-renders
  // cards away, and a detail opening 250ms later would open over a card that is
  // no longer on the board.
  useEffect(() => () => { activation.cancel() }, [activation])

  const ariaLabel = [
    title.kind === undefined ? summary : `${title.kind}: ${title.text}`,
    !archived && pending ? t('board.pending') : '',
    !archived && runtimeLabel !== '' ? runtimeLabel : '',
    !archived && runtimeLabel === '' && busy ? t(runningKey ?? 'detail.result.running') : '',
    !archived && !busy && resultText !== '' ? resultText : '',
    outcome.declared ? t('card.declared') : '',
    subtasksFailed > 0 ? t('card.subtasksFailed', { count: String(subtasksFailed) }) : '',
    tagNames.length > 0 ? t('card.tagsLabel', { tags: tagNames.join(', ') }) : '',
  ].filter(Boolean).join(' · ')
  // The tooltip names what the clamped surface cannot show — the full title and
  // the absolute instant — not the whole excerpt again.
  const tooltip = [
    summary,
    t(timeline.key, { time: formatHostTimestamp(timeline.at, timeZone) }),
    outcome.declared ? t('card.declaredHint') : '',
  ].filter(Boolean).join('\n')

  const sessionMark = sessionId !== undefined && (onOpenSession !== undefined ? (
    <button
      type="button"
      className={`${css.cardSession} ${css.cardAction}`}
      data-dsh-part="card-session"
      title={t('card.openSession')}
      aria-label={t('card.openSession')}
      onClick={() => { onOpenSession(sessionId, workspaceId) }}
    >
      <IconSession size={14} />
    </button>
  ) : (
    <span className={css.cardSession} title={sessionId}>
      <IconSession size={12} />
    </span>
  ))
  const decoration = <span className={css.cardDecoration}>{cardDecoration({ task })}</span>
  // The one way a card reaches the verified column: a person presses this and
  // the dialog decides the git steps. It rides both densities, because the
  // settled columns (and the done card this acts on) open compact by default.
  const verifyAction = !archived && onVerify !== undefined && canVerifyCard(task) && (
    <button
      type="button"
      className={css.cardVerify}
      data-dsh-part="card-verify"
      disabled={pending}
      title={t('verifyTask.buttonHint')}
      onClick={() => { onVerify(task.id) }}
    >
      {t('verifyTask.button')}
    </button>
  )
  const timeLabel = <span className={css.cardTime} data-dsh-part="card-time">{t(timeline.key, { time: formatCardTime(timeline.at, timeZone) })}</span>
  const kindBadge = title.kind !== undefined && (
    <span className={css.cardKind} data-dsh-part="card-kind">{title.kind}</span>
  )
  // The live state reads as a badge in every density, so a card parked in a
  // dense column still says whether the run is working, waiting for you, or
  // stopped. Its tooltip carries the one-line explanation the badge cannot.
  const stateBadge = runtime !== undefined && (
    <span
      className={css.cardState}
      data-state={runtime}
      data-dsh-part="card-state"
      title={t(RUNTIME_HINT_KEY[runtime])}
    >
      {runtimeLabel}
    </span>
  )
  // Tags render in both densities: a label is how the user finds a card again,
  // and the compact column is where a running or settled card is easiest to
  // lose. Compact clips the row to one line instead of dropping it (the
  // aria-label still lists every tag).
  const tagRow = task.tags !== undefined && task.tags.length > 0 && (
    <span className={css.cardTags} data-dsh-part="card-tags">
      {task.tags.map(tag => (
        <span
          key={tag.name}
          className={css.cardTag}
          data-tag-tone={tagTone(tag.name)}
          data-dsh-part="tag-badge"
          data-tag-hint={tag.promptPrefix === undefined ? undefined : tag.promptPrefix}
          title={tag.promptPrefix === undefined ? tag.name : tag.promptPrefix}
        >
          {tag.name}
        </span>
      ))}
    </span>
  )

  return (
    <article
      className={css.card}
      data-status={archived ? 'archived' : task.status}
      data-tone={outcome.tone}
      data-compact={compact || undefined}
      data-dsh-part="card"
      data-pending={pending || undefined}
      data-runtime={runtime}
      draggable={isDraggable}
      onDragStart={isDraggable ? (event) => {
        event.dataTransfer.setData('text/plain', task.id)
        event.dataTransfer.effectAllowed = 'move'
        // A drag is never the click it follows: drop the window an earlier click
        // of this card may have opened, so the detail cannot appear mid-drop.
        activation.cancel()
      } : undefined}
      title={tooltip}
      onClick={(event) => {
        // A quick action (session, provider link) handles its own click, and it
        // ends any window a body click of this card may have opened: the action
        // is a complete gesture on its own, and a late `openDetail()` would
        // otherwise select the card behind a board the action just closed.
        const target = event.target as Element
        if (target.closest('a, button:not([data-dsh-part="card-open"])') !== null) {
          activation.cancel()
          return
        }
        // Keyboard activation of the stretched open control synthesizes a click
        // with no pointer detail (`detail === 0`): one press, one meaning, so it
        // opens the detail at once instead of joining a window it cannot complete.
        if (event.detail === 0) {
          activation.activate()
          return
        }
        activation.click(sessionId)
      }}
    >
      <button type="button" className={css.cardOpen} data-dsh-part="card-open" aria-label={ariaLabel} />
      <span className={css.cardTitleRow}>
        {kindBadge}
        <span className={css.cardTitle} data-dsh-part="card-title">{title.text}</span>
      </span>
      {compact ? (
        <>
          {tagRow}
          <span className={css.cardMeta}>
            {stateBadge}
            {decoration}
            {timeLabel}
            {/* The entry belongs to every density: a settled column opens compact,
                and a card that ran there must still offer its session. */}
            {sessionMark}
            {verifyAction}
            {!archived && (busy || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
          </span>
        </>
      ) : (
        <>
          {tagRow}
          {excerpt !== '' && <span className={css.cardExcerpt} data-dsh-part="card-excerpt">{excerpt}</span>}
          <span className={css.cardMeta}>
            {stateBadge}
            {decoration}
            {isSubtask && (
              <span className={css.cardSubtask} data-dsh-part="subtask-badge">{t('card.subtask')}</span>
            )}
            {subtaskCount > 0 && (
              // A board that hides subtask cards still has to report them: the badge
              // rolls up the direct children and takes the tone of the worst state,
              // so a hidden failing tree cannot look green.
              <span
                className={css.cardSubtask}
                data-dsh-part="subtask-count"
                data-tone={subtasksFailed > 0 ? 'failed' : subtasksRunning > 0 ? 'running' : subtasksDone === subtaskCount ? 'done' : undefined}
                title={t('card.subtasksBreakdown', {
                  total: String(subtaskCount),
                  done: String(subtasksDone),
                  running: String(subtasksRunning),
                  failed: String(subtasksFailed),
                })}
              >
                {t('card.subtasks', { count: String(subtaskCount) })}
                {subtasksFailed > 0 ? ' · ' + t('card.subtasksFailed', { count: String(subtasksFailed) }) : ''}
                {subtasksFailed === 0 && subtasksRunning > 0 ? ' · ' + t('card.subtasksRunning', { count: String(subtasksRunning) }) : ''}
              </span>
            )}
            {timeLabel}
            {task.freeze !== undefined && (
              <span className={css.cardSchedule} title={task.freeze.goal}>{t('card.frozen')}</span>
            )}
            {!archived && task.schedule?.enabled === true && (
              <span
                className={css.cardSchedule}
                title={task.schedule.nextRunAt !== undefined
                  ? `${t(task.schedule.mode === 'once' ? 'card.scheduledOnce' : 'card.scheduled')} · ${formatHostTimestamp(task.schedule.nextRunAt, timeZone)}`
                  : t(task.schedule.mode === 'once' ? 'card.scheduledOnce' : 'card.scheduled')}
              >
                <IconClock size={12} />
                {t(task.schedule.mode === 'once' ? 'card.scheduledOnce' : 'card.scheduled')}
              </span>
            )}
            {latest !== undefined && (
              <span
                className={css.cardRun}
                data-dsh-part="card-run"
                data-result={archived || latest.result === undefined ? undefined : latest.result}
                data-declared={outcome.declared || undefined}
                title={outcome.declared ? t('card.declaredHint') : undefined}
              >
                {!busy && resultText !== '' ? `${resultText} · ` : ''}
                {runs} {t('board.runs')}
                {outcome.declared ? ` · ${t('card.declared')}` : ''}
              </span>
            )}
            {sessionMark}
            {verifyAction}
            {!archived && (busy || pending) && <span className={css.cardSpinner} aria-hidden="true" />}
          </span>
          {!archived && pending && <span className={css.cardRunningLabel}>{t('board.pending')}…</span>}
          {!archived && runningLabel !== '' && <span className={css.cardRunningLabel}>{runningLabel}</span>}
        </>
      )}
    </article>
  )
}

/** Memoized card: re-renders only when the card's own task record changes. */
export const TaskCard = memo(TaskCardInner)

/**
 * The title-bar button that walks the card <-> session link backwards: from the
 * conversation you are reading to the card the board holds for it.
 *
 * It mounts in `conversation.session.header.actions`, the list seat the
 * conversation header renders right after the session name, so it appears on
 * every session. That seat renders its entries with empty owner props — the
 * per-session identity arrives as the framework's standard `sessionId` prop for
 * a session-scoped seat. The `sessions` face stays as the fallback for a shell
 * that renders the seat without a scope binding, and as the subscription that
 * keeps the button honest when the main view switches session.
 *
 * Click behaviour is decided in ONE place (`resolveSessionLink`): disabled when
 * no card is associated, a direct jump when exactly one is, and a picker when
 * several are — the user then chooses instead of the board guessing.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/SessionBoardLink
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BoardController, SessionsControllerFace } from '../core/controller.ts'
import type { TaskRecord } from '../core/tasks.ts'
import { STATUS_KEY } from './board/status-key.ts'
import { t } from './locales.ts'
import { resolveSessionLink, type SessionLinkState } from './session-cards.ts'
import { SessionBindModal } from './SessionBindModal.tsx'
import css from './session-link.module.css'

/** The conversation header's actions seat (declared by dsh-client-ui-conversation). */
const HEADER_SEAT = 'conversation.session.header.actions'

/** Sort order inside that seat; the jobs entry owns 20. */
const HEADER_ORDER = 30

/** Registration identity inside the seat. */
const HEADER_ID = 'task-board-link'

/** The faces the plugin hands the button; both live for the plugin's lifetime. */
export interface SessionBoardFaces {
  /** Board controller: its snapshot holds the cards, its methods do the jump. */
  controller: BoardController
  /** Session catalog face: the fallback source of "which session is this". */
  sessions: SessionsControllerFace
}

/** Props of the seat entry: injected faces plus the framework's session binding. */
export interface SessionBoardLinkProps extends SessionBoardFaces {
  /** Session this header renders for, bound by the framework for the seat. */
  sessionId?: string
}

/** The board glyph: a board outline with its selected column marked. */
function IconBoardLink(): React.ReactElement {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.8" y="2.6" width="12.4" height="10.8" rx="1.6" />
      <path d="M1.8 6h12.4M6 6v7.4" />
      <path d="M9 8.4h3" />
    </svg>
  )
}

/**
 * Track the session the main view shows, as the fallback identity.
 *
 * One subscription per component instance, created once: the face object is
 * stable, so the effect does not rebuild it on re-render, and a session switch
 * arrives as a catalog change rather than a poll.
 * @param sessions - the session catalog face.
 * @returns the main-view session id, or undefined when none is shown.
 */
function useTrackedSession(sessions: SessionsControllerFace): string | undefined {
  const [current, setCurrent] = useState(() => sessions.current())
  useEffect(() => {
    setCurrent(sessions.current())
    return sessions.subscribe(() => { setCurrent(sessions.current()) })
  }, [sessions])
  return current
}

/** The association reasons of one card, as the badges the row shows. */
function reasonsOf(card: SessionLinkState['cards'][number]): string[] {
  const reasons: string[] = []
  if (card.viaExecution) reasons.push(t('sessionLink.viaExecution'))
  if (card.viaCreatedBy) reasons.push(t('sessionLink.viaCreatedBy'))
  return reasons
}

/** Session-title-bar button into the board. */
export function SessionBoardLink({ controller, sessions, sessionId }: SessionBoardLinkProps): React.ReactElement {
  // The controller snapshot is rebuilt per notify, so the board's own surfaces
  // subscribe the same way (useState + subscribe) instead of treating
  // getSnapshot's identity as stable.
  const [snapshot, setSnapshot] = useState(() => controller.getSnapshot())
  useEffect(() => controller.subscribe(() => { setSnapshot(controller.getSnapshot()) }), [controller])

  const tracked = useTrackedSession(sessions)
  const activeId = sessionId ?? tracked
  const link = useMemo(() => resolveSessionLink(snapshot.tasks, activeId), [snapshot.tasks, activeId])

  // A turn of THIS session may be blocked on the binding modal. The prompt is
  // published for every session, and only the one it names may answer it — the
  // header is the one surface that knows which session it is rendering for.
  const binding = (snapshot.binding ?? []).find(prompt => prompt.sessionId === activeId)

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLUListElement>(null)
  const wasOpen = useRef(false)

  // A live snapshot can dissolve the choice being offered (another card
  // settled, a card was archived). The panel must not outlive its own reason.
  useEffect(() => {
    if (open && link.mode !== 'choose') setOpen(false)
  }, [open, link.mode])

  // Return focus to the trigger whenever the panel closes by any route; the
  // user's next Tab then continues from where the menu was opened.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus()
    wasOpen.current = open
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // The header is inside the conversation's own key handling; the menu is
      // the innermost surface, so it consumes the key while it is up.
      event.stopPropagation()
      setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown, true)
    }
  }, [open])

  // A freshly opened menu puts focus on its first item, so a keyboard user can
  // choose without hunting for the panel.
  useEffect(() => {
    if (!open) return
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])

  const jumpTo = useCallback((task: TaskRecord): void => {
    setOpen(false)
    // The target is always a live board card, so a board left in the archive
    // view has to come back to the columns first — otherwise the jump lands on
    // a view that does not render the card.
    if (controller.getSnapshot().archiveView) controller.toggleArchiveView()
    controller.openBoard()
    controller.openTask(task.id)
  }, [controller])

  const onClick = (): void => {
    if (link.mode === 'none') return
    if (link.mode === 'jump' && link.target !== undefined) {
      jumpTo(link.target)
      return
    }
    setOpen(value => !value)
  }

  const disabled = link.mode === 'none'
  const label = disabled
    ? t('sessionLink.none')
    : link.mode === 'jump' ? t('sessionLink.open') : t('sessionLink.choose')

  return (
    <>
      <span className={css.root} ref={rootRef}>
        <button
          type="button"
          ref={buttonRef}
          className={disabled ? `${css.button} ${css.buttonDisabled}` : css.button}
          onClick={onClick}
          title={label}
          aria-label={label}
          aria-disabled={disabled || undefined}
          aria-haspopup={link.mode === 'choose' ? 'menu' : undefined}
          aria-expanded={link.mode === 'choose' ? open : undefined}
        >
          <IconBoardLink />
        </button>
        {open && (
          <ul className={css.panel} role="menu" aria-label={t('sessionLink.menu')} ref={panelRef}>
            {link.cards.map(card => (
              <li key={card.task.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  className={css.item}
                  onClick={() => { jumpTo(card.task) }}
                >
                  <span className={css.itemTitle}>{card.task.title}</span>
                  <span className={css.meta}>
                    <span>{t(STATUS_KEY[card.task.status])}</span>
                    {reasonsOf(card).map(reason => (
                      <span className={css.reason} key={reason}>{reason}</span>
                    ))}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </span>
      {/* The modal lives OUTSIDE the header's inline wrapper: it is a
        * fixed-position layer, and the span is only the button's box. It also
        * must not sit inside a span (invalid nesting). */}
      {binding !== undefined && (
        <SessionBindModal
          prompt={binding}
          onChoose={taskId => { controller.chooseBinding(binding.sessionId, taskId) }}
        />
      )}
    </>
  )
}

/**
 * Contribute the button to the conversation header.
 *
 * `inject` waits for the seat to be declared: the conversation shell is a
 * sibling plugin that may apply after this one, and a shell that never declares
 * the seat leaves the button simply absent.
 * @param ctx - client root context (services: slots).
 * @param faces - the controller and session face the button drives.
 * @returns disposer releasing the registration.
 */
export function registerSessionBoardLink(ctx: ClientContext, faces: SessionBoardFaces): () => void {
  const slots = ctx.slots as {
    inject(key: string, callback: () => () => void): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  return slots.inject(HEADER_SEAT, () => slots.register({
    name: HEADER_SEAT,
    id: HEADER_ID,
    order: HEADER_ORDER,
    inject: () => faces,
  }, SessionBoardLink as never))
}

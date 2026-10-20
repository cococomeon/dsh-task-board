/**
 * The blocking modal a turn raises when a session has more than one card it
 * could bind.
 *
 * It is deliberately a FORCE-CHOICE surface: the Host is holding the turn open
 * until this component answers or the Host's own deadline expires, so the
 * dialog offers no "close" affordance — Escape sends the explicit "none this
 * turn" answer instead of silently dismissing, and the countdown tells the user
 * what happens if they do nothing.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/SessionBindModal
 */
import { useEffect, useState } from 'react'
import type { TaskBoardBindingPrompt } from '../protocol.ts'
import { useDialog } from './board/overlay.tsx'
import { STATUS_KEY } from './board/status-key.ts'
import { t } from './locales.ts'
import css from './session-link.module.css'

/** Props: the prompt to answer, plus the controller's answer call. */
export interface SessionBindModalProps {
  /** The turn waiting for an answer; its deadline drives the countdown. */
  prompt: TaskBoardBindingPrompt
  /** Deliver the answer; `null` means "none of these this turn". */
  onChoose: (taskId: string | null) => void
}

/** Seconds left before the Host stops waiting (never negative). */
function remainingSeconds(deadlineAt: number, now: number): number {
  return Math.max(0, Math.ceil((deadlineAt - now) / 1_000))
}

/**
 * Session-scoped blocking picker.
 * @param props - see {@link SessionBindModalProps}.
 */
export function SessionBindModal({ prompt, onChoose }: SessionBindModalProps): React.ReactElement {
  const skip = (): void => { onChoose(null) }
  const dialog = useDialog<HTMLDivElement>(skip, 'open')
  const [now, setNow] = useState(() => Date.now())
  // One ticker per mounted modal: the deadline lives on the Host, so the
  // countdown must be re-derived rather than counted down locally.
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [])
  const seconds = remainingSeconds(prompt.deadlineAt, now)
  return (
    <div className={css.bindBackdrop} onMouseDown={dialog.onMouseDown}>
      <div
        ref={dialog.attach}
        className={css.bindModal}
        role="alertdialog"
        aria-modal="true"
        aria-label={t('sessionBind.title')}
        tabIndex={-1}
      >
        <h2 className={css.bindTitle}>{t('sessionBind.title')}</h2>
        <p className={css.bindHint}>{t('sessionBind.hint')}</p>
        <ul className={css.bindList}>
          {prompt.candidates.map(card => (
            <li key={card.taskId} role="none">
              <button type="button" className={css.bindItem} onClick={() => { onChoose(card.taskId) }}>
                <span className={css.bindItemTitle}>{card.title}</span>
                <span className={css.bindMeta}>
                  <span>{t(STATUS_KEY[card.status])}</span>
                  {card.viaExecution && <span className={css.reason}>{t('sessionLink.viaExecution')}</span>}
                  {card.viaCreatedBy && <span className={css.reason}>{t('sessionLink.viaCreatedBy')}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className={css.bindDeadline}>{t('sessionBind.deadline', { seconds: String(seconds) })}</p>
        <footer className={css.bindFooter}>
          <button type="button" className={css.bindSkip} onClick={skip}>
            {t('sessionBind.skip')}
          </button>
        </footer>
      </div>
    </div>
  )
}

/**
 * Human verification dialog: the two switches that decide whether the ledger
 * step is preceded by git work, and the only surface that can tell the Host
 * "a person verified this".
 *
 * Verification is a Host action (`controller.verifyTask`), so the outcome is
 * read off the controller snapshot instead of awaited: the card turns pending
 * while the Host runs the git steps, and the dialog stays open with the Host's
 * own message when a step failed (the card keeps its Done column, which is the
 * contract's "both steps succeed before the status moves"). The two switches
 * are remembered in the browser, because the same operator repeats the same
 * answer, and a forgotten switch would either push code nobody asked to push
 * or silently skip the commit they always want.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/board/VerifyTaskModal
 */
import { useCallback, useEffect, useState } from 'react'
import type { BoardController } from '../../core/controller.ts'
import type { TaskRecord } from '../../core/tasks.ts'
import { t } from '../locales.ts'
import css from '../board.module.css'
import type { OverlayPhase } from './overlay.tsx'
import { ModalShell } from './TaskForm.tsx'

/** Browser storage key of the remembered verification switches. */
export const VERIFY_OPTIONS_KEY = 'dsh.taskBoard.verifyOptions.v1'

/** The two optional git steps of one verification. */
export interface VerifyOptions {
  /** Run `git add -A` + `git commit` in the card's workspace first. */
  commit: boolean
  /** Push the workspace branch to the gerrit review ref afterwards. */
  push: boolean
}

/** Both switches off: what a browser that remembered no answer does. */
export const DEFAULT_VERIFY_OPTIONS: VerifyOptions = { commit: false, push: false }

/**
 * Read the remembered switches. An unreadable value falls back to both off,
 * which is the safe direction: verification still changes the status, and no
 * git step runs that the user did not ask for.
 * @param storage - browser storage (absent outside a browser).
 */
export function readVerifyOptions(storage: Pick<Storage, 'getItem'> | undefined): VerifyOptions {
  try {
    const raw = storage?.getItem(VERIFY_OPTIONS_KEY)
    if (raw === null || raw === undefined) return { ...DEFAULT_VERIFY_OPTIONS }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_VERIFY_OPTIONS }
    const record = parsed as Record<string, unknown>
    return { commit: record.commit === true, push: record.push === true }
  } catch {
    return { ...DEFAULT_VERIFY_OPTIONS }
  }
}

/**
 * Persist the switches; a storage failure (quota, privacy mode) only loses the
 * memory.
 * @param storage - browser storage (absent outside a browser).
 * @param options - the switches to remember.
 */
export function writeVerifyOptions(storage: Pick<Storage, 'setItem'> | undefined, options: VerifyOptions): void {
  try {
    storage?.setItem(VERIFY_OPTIONS_KEY, JSON.stringify({ commit: options.commit, push: options.push }))
  } catch {
    // Preference only: the dialog keeps working with the in-memory choice.
  }
}

/** Human verification dialog for one Done card. */
export function VerifyTaskModal({ controller, task, onClose, phase }: {
  controller: BoardController
  task: TaskRecord
  onClose: () => void
  phase?: OverlayPhase
}) {
  const [snapshot, setSnapshot] = useState(controller.getSnapshot())
  useEffect(
    () => controller.subscribe(() => setSnapshot(controller.getSnapshot())),
    [controller],
  )
  const [options, setOptions] = useState<VerifyOptions>(() => readVerifyOptions(globalThis.localStorage))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const hostPending = snapshot.pendingTaskIds.includes(task.id)
  const pending = submitting || hostPending
  // The Host action returns nothing, so the wait is the card's own pending
  // mark: it starts with the submit and ends when the Host settles the action.
  // A failure arrives as the transport error and keeps the dialog open — the
  // card is still Done, and closing would hide why it stayed there.
  useEffect(() => {
    if (!submitting || hostPending) return
    setSubmitting(false)
    const failure = snapshot.transportError
    if (failure !== undefined) {
      setError(t('verifyTask.failed', { error: failure }))
      return
    }
    onClose()
  }, [submitting, hostPending, snapshot.transportError, onClose])

  const toggle = useCallback((patch: Partial<VerifyOptions>): void => {
    setOptions(current => {
      const next = { ...current, ...patch }
      writeVerifyOptions(globalThis.localStorage, next)
      return next
    })
  }, [])

  const submit = (): void => {
    if (pending) return
    setError(undefined)
    setSubmitting(true)
    controller.verifyTask(task.id, { commit: options.commit, push: options.push })
  }

  return (
    <ModalShell
      ariaLabel={t('verifyTask.title')}
      title={t('verifyTask.title')}
      error={error}
      pending={pending}
      submitLabel={t('verifyTask.submit')}
      onSubmit={submit}
      // A submit in flight is not abandonable: the Host is already running the
      // git steps, so Escape must not leave the user with a closed dialog and
      // no way to read the outcome.
      onClose={() => { if (!pending) onClose() }}
      phase={phase}
    >
      <p className={css.verifyHint}>{t('verifyTask.hint')}</p>

      <label className={css.verifyOption}>
        <input
          type="checkbox"
          checked={options.commit}
          disabled={pending}
          onChange={event => { toggle({ commit: event.target.checked }) }}
        />
        <span>{t('verifyTask.commit')}</span>
      </label>
      <p className={css.verifyHint}>{t('verifyTask.commitHint', { message: `${task.title} (#${task.id})` })}</p>

      <label className={css.verifyOption}>
        <input
          type="checkbox"
          checked={options.push}
          disabled={pending}
          onChange={event => { toggle({ push: event.target.checked }) }}
        />
        <span>{t('verifyTask.push')}</span>
      </label>
      <p className={css.verifyHint}>{t('verifyTask.pushHint')}</p>

      <p className={css.verifyHint}>{t('verifyTask.order')}</p>
      {pending && <p className={css.verifyHint} role="status">{t('verifyTask.pending')}</p>}
    </ModalShell>
  )
}

/**
 * Verify-task use case: move a settled `done` card into `verified`.
 *
 * Pure ledger transition with an outcome — no persistence, no notify, and no
 * git (the commit/push orchestration belongs to the Host service, which owns
 * the workspace and the process). It is shaped like `applySetParent`: the
 * refusal reason travels back to the caller instead of being thrown, so the
 * ledger's action switch stays the one place that turns a refusal into an
 * error for the wire.
 *
 * This is the board's only route into `verified`. Nothing the runner settles
 * lands there — verification is a human claim about a finished card, not an
 * outcome a run can produce.
 */
import { canVerifyTask, hasOpenExecution, withStatus, type TaskRecord } from '../tasks.ts'

export interface VerifyTaskResult {
  applied: boolean
  error?: string
  tasks: readonly TaskRecord[]
}

/**
 * Verify one card: stamp it `verified` with a fresh updatedAt.
 * @param tasks - current ledger.
 * @param id - the card to verify.
 * @param now - clock instant (ms epoch).
 * @returns the ledger (unchanged when refused) plus the refusal reason.
 */
export function applyVerifyTask(
  tasks: readonly TaskRecord[],
  id: string,
  now: number,
): VerifyTaskResult {
  const task = tasks.find(item => item.id === id)
  if (task === undefined) return { applied: false, error: 'task not found', tasks }
  if (task.archivedAt !== undefined) return { applied: false, error: 'archived task is read-only', tasks }
  // Checked before the column so a card that is both running and not done gets
  // the reason an operator can act on: the run must settle (or be closed) first.
  if (hasOpenExecution(task)) return { applied: false, error: 'running task cannot be verified', tasks }
  if (!canVerifyTask(task)) return { applied: false, error: 'only a settled done card can be verified', tasks }
  return {
    applied: true,
    tasks: tasks.map(item => item.id === id ? withStatus(item, 'verified', now) : item),
  }
}

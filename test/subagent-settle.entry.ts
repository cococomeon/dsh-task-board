/**
 * Real-path checks for the SUBAGENT gate on the runner's settle path
 * (`TaskBoardHostService.reconcileExecutions`).
 *
 * Background: a run's execution session can end its turn while the agents that
 * turn spawned are still working. A subagent has its own loop and its own turns,
 * so the verdict read from the parent session says nothing about them — and the
 * board used to close the card on exactly that verdict (a card settled while its
 * subagent was mid-run). The service now skips the settle while the session has
 * a busy descendant, and the next poll picks the verdict up once the last one
 * goes idle.
 *
 * This entry drives the REAL service (bundled through esbuild by test/run.mjs)
 * against a real HostTaskLedger in a temp directory. Two seams are stands-in,
 * both of them things a unit test cannot own: the gateway-facing runner (its
 * `inspect` would otherwise need a live DSH session log) and the private poll
 * entry (called through a cast), while the settle logic under test is the real
 * one.
 *
 * Usage: node test/run.mjs test/subagent-settle.entry.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { TaskBoardHostService } from '../src/host-service.ts'

const NOW = 1_760_000_000_000
const SESSION = 'session-parent-1111-2222-3333-444455556666'

const line = (label: string, value?: unknown): void => {
  process.stdout.write(`  ok  ${label}${value === undefined ? '' : ` -> ${JSON.stringify(value)}`}\n`)
}

/** The two faces of HostExecutionRunner the poll uses, as a controllable stand-in. */
interface FakeRunner {
  listRunning(): Promise<{ known: true; count: number; items: { sessionId: string; running: boolean }[] }>
  inspect(): Promise<{ outcome: 'succeeded' }>
}

/** One service + ledger pair over a temp directory, with a scripted runner. */
function hosted(hasBusy: () => boolean): {
  ledger: HostTaskLedger
  service: TaskBoardHostService
  poll: () => Promise<boolean>
  runner: FakeRunner
  dir: string
} {
  const dir = mkdtempSync(join(tmpdir(), 'tb-subagent-'))
  const ledger = new HostTaskLedger(dir, () => NOW)
  const service = new TaskBoardHostService({} as never, {
    ledger,
    now: () => NOW,
    hasBusyDescendant: () => hasBusy(),
  })
  const runner: FakeRunner = {
    // The run's own session is present in the roster and NOT running: its turn
    // ended, which is exactly the moment that used to settle the card.
    listRunning: async () => ({ known: true, count: 0, items: [{ sessionId: SESSION, running: false }] }),
    inspect: async () => ({ outcome: 'succeeded' }),
  }
  // The runner is a plain instance field; `inspect` needs a live session log, so
  // the scripted face replaces it. Everything under test (reconciliation,
  // settle, verification gates) stays the real code.
  Object.defineProperty(service, 'runner', { value: runner, configurable: true, writable: true })
  const poll = async (): Promise<boolean> =>
    await (service as unknown as { pollSessions(): Promise<boolean> }).pollSessions()
  return { ledger, service, poll, runner, dir }
}

/** Open a real execution for one card and attach the session that runs it. */
function openRun(ledger: HostTaskLedger, taskId: string): { executionId: string } {
  const opened = ledger.applyRequest(`open-${taskId}`, {
    kind: 'create',
    id: taskId,
    input: { title: `card ${taskId}`, description: '', prompt: 'p' },
  })
  assert.ok(opened !== undefined)
  const run = ledger.applyRequest(`run-${taskId}`, { kind: 'run', taskId })
  const execution = run.runs?.[0]?.execution
  assert.ok(execution !== undefined, `the run did not open an execution for ${taskId}`)
  ledger.attachSession(taskId, execution.id, SESSION)
  return { executionId: execution.id }
}

// --- A: busy descendant -> the poll must NOT settle ------------------------
{
  let busy = true
  const { ledger, service, poll, runner, dir } = hosted(() => busy)
  const { executionId } = openRun(ledger, 'sub-busy')
  assert.equal(ledger.getTask('sub-busy')?.status, 'running')
  // The stand-in's verdict is a clean success — with no gate this settles.
  assert.deepEqual(await runner.inspect(), { outcome: 'succeeded' })

  await poll()
  let task = ledger.getTask('sub-busy')
  assert.equal(task?.status, 'running', 'the card was settled while a subagent was still running')
  assert.equal(task?.executions.find(entry => entry.id === executionId)?.endedAt, undefined, 'the execution was closed')
  line('inspect=succeeded + busy descendant -> execution stays open, card stays running', `${dir}`)

  // --- B: the descendant goes idle -> the NEXT poll settles it ------------
  busy = false
  await poll()
  task = ledger.getTask('sub-busy')
  assert.equal(task?.status, 'done', 'the card did not settle once the descendants were idle')
  assert.notEqual(task?.executions.find(entry => entry.id === executionId)?.endedAt, undefined, 'the execution stayed open')
  line('same poll after the descendant goes idle -> settled to done')
  service.dispose()
}

// --- C: no reader installed -> pre-existing behaviour (settles at once) -----
{
  const dir = mkdtempSync(join(tmpdir(), 'tb-subagent-none-'))
  const ledger = new HostTaskLedger(dir, () => NOW)
  const service = new TaskBoardHostService({} as never, { ledger, now: () => NOW })
  Object.defineProperty(service, 'runner', {
    value: {
      listRunning: async () => ({ known: true, count: 0, items: [{ sessionId: SESSION, running: false }] }),
      inspect: async () => ({ outcome: 'succeeded' }),
    },
    configurable: true,
    writable: true,
  })
  openRun(ledger, 'no-reader')
  await (service as unknown as { pollSessions(): Promise<boolean> }).pollSessions()
  assert.equal(ledger.getTask('no-reader')?.status, 'done')
  line('without the optional reader the old behaviour is unchanged (settles immediately)')
  service.dispose()
}

process.stdout.write('\nsubagent-settle: all checks passed\n')

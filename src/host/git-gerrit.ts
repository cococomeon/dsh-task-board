/**
 * git commit + gerrit push, as one Host-side step.
 *
 * This is the only place the task board touches a user's repository, so it is
 * deliberately narrow: every git invocation is an argv array launched with
 * `spawn` and `shell: false` (a card title reaches `commit -m`, and a title
 * containing `;` or a backtick must reach git as one argument, never as shell
 * syntax), and `cwd` is always the workspace path itself rather than a `-C`
 * carried through a relative path. Nothing here mutates the workspace beyond
 * the two documented commands: no checkout, no stash, no clean, no config edit,
 * and no force flag — a rejected push is a failure to report, not something to
 * retry with `--force`.
 *
 * The push target is gerrit's magic ref, `HEAD:refs/for/<current branch>`: the
 * branch is read from the workspace (never guessed) because pushing `refs/heads`
 * would bypass review, and a detached HEAD has no branch to name, so it fails
 * instead of inventing one.
 *
 * Whether a commit landed is likewise read from the workspace rather than from
 * git's prose: HEAD is measured before and after, so a hook that prints
 * reassuring lines and then refuses cannot be mistaken for a landed commit.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

/**
 * Per-step fallback for a caller that passes no usable budget: git must never be
 * given an unbounded window, or a wedged push would hang whatever drove it.
 */
export const DEFAULT_GIT_SYNC_TIMEOUT_MS = 120_000
/** The contract's "tail of the merged output" — a board popup is not a log viewer. */
export const MAX_GIT_OUTPUT_BYTES = 4_096
/**
 * A stall watchdog on top of the deadline: a git child blocked on a credential
 * prompt holds the pipe open without writing, so "no output for two minutes" is
 * treated as stuck rather than waited out.
 */
const SILENCE_LIMIT_MS = 120_000
const SILENCE_POLL_MS = 1_000

/**
 * Every git child gets the caller's environment plus this one variable. The Host
 * runs without a TTY, so an unset credential would otherwise make git read from
 * a terminal that is not there and burn the whole budget before reporting a
 * timeout instead of an authentication failure. Set here, not left to the
 * caller, because "does this module prompt?" must have one answer.
 */
function gitEnv(): NodeJS.ProcessEnv {
  // Read at spawn time, not at module load: the Host may still be assembling its
  // environment when this module is imported, and a frozen copy would silently
  // ignore that.
  return { ...process.env, GIT_TERMINAL_PROMPT: '0' }
}

export interface GitSyncRequest {
  /** 卡片绑定工作区的绝对路径（Workspace.path）。 */
  workspacePath: string
  /** 提交信息。 */
  message: string
  /** 执行 git add -A + git commit。 */
  commit: boolean
  /** 推送 HEAD 到 refs/for/<当前分支>。 */
  push: boolean
  /** 远端名，默认 'origin'。 */
  remote: string
  /** 整个序列的硬超时。 */
  timeoutMs: number
}

export interface GitSyncResult {
  ok: boolean
  committed: boolean
  commitSha?: string
  /** 工作区干净、没有可提交内容（此时 committed 为 false 且 ok 仍为 true）。 */
  nothingToCommit?: boolean
  pushed: boolean
  branch?: string
  refspec?: string
  error?: string
  /** 失败步骤的 stdout+stderr 合并尾部（截断，建议 4KB）。 */
  output?: string
}

interface GitOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  issue?: string
  timedOut: boolean
  output: string
}

/** The narrowest slice of `spawn` this module needs, so a test can stand in for git. */
export type GitSpawnLike = (
  file: string,
  args: readonly string[],
  options: { cwd: string; shell: false; windowsHide: boolean; signal: AbortSignal; env: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

export interface GitSyncOptions {
  spawn?: GitSpawnLike
  /** Test seam for the wall clock behind the deadline and the stall watchdog. */
  now?: () => number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A killed step looks like three different things depending on the platform and
 * on whether `spawn` ever produced a process: the watchdog flag, a `signal`, or
 * a spawn-level error. Folding them into one `detail` keeps the caller from
 * having to know which one happened.
 */
function stepFailure(outcome: GitOutcome, timeoutMs: number): string | undefined {
  if (outcome.timedOut || (outcome.issue !== undefined && outcome.issue.includes('AbortError'))) {
    return `timed out after ${timeoutMs}ms`
  }
  if (outcome.issue !== undefined) return outcome.issue
  if (outcome.code === null) return `killed by ${String(outcome.signal ?? 'an unknown signal')}`
  return undefined
}

/**
 * Why a non-zero step ended that way: the killed/failed detail when there is
 * one, the raw exit code otherwise, and nothing at all when the step succeeded.
 */
function nonZeroDetail(outcome: GitOutcome, timeoutMs: number): string | undefined {
  if (outcome.code === 0) return undefined
  return stepFailure(outcome, timeoutMs) ?? (outcome.code === null ? 'no exit code' : `exit ${String(outcome.code)}`)
}

/** `--porcelain` names any tracked change, so an empty answer means the commit would be empty. */
function isCleanPorcelain(output: string): boolean {
  return output.split('\n').every(line => line.slice(0, 2).trim() === '')
}

/**
 * git's own "I had nothing to do" reports: the commit exits non-zero on a clean
 * tree, and `git add -A` says `no changes added to commit` when the only changes
 * are ignored files. Both are an expected terminal state, not a broken sync.
 */
function isNothingToCommit(output: string): boolean {
  return /nothing to commit|no changes added to commit/i.test(output)
}

/**
 * One readable line: which step, how it ended, and why. The "why" is dropped
 * when the exit code is the whole story — repeating `exit 128` as the detail
 * reads like a stutter, not a diagnosis.
 */
function failureLine(step: string, code: number | null, detail: string | undefined): string {
  const exit = code === null ? 'no exit code' : `exit ${String(code)}`
  if (detail === undefined || detail === exit) return `${step} failed (${exit})`
  return `${step} failed (${exit}): ${detail}`
}

/** Node reports a non-UTF8 byte as U+FFFD; a NUL would make the board's JSON transport sad. */
function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
}

export async function runGitSync(request: GitSyncRequest, options: GitSyncOptions = {}): Promise<GitSyncResult> {
  const spawnGit: GitSpawnLike =
    options.spawn ??
    ((file, args, spawnOptions) => spawn(file, [...args], { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] }))
  const now = options.now ?? ((): number => Date.now())
  const remote = request.remote.trim() === '' ? 'origin' : request.remote
  const budget = Number.isFinite(request.timeoutMs) && request.timeoutMs > 0 ? request.timeoutMs : DEFAULT_GIT_SYNC_TIMEOUT_MS

  const result: GitSyncResult = { ok: false, committed: false, pushed: false }
  // One deadline for the whole sequence, converted to a per-step signal: the
  // caller's number budgets the sync, not each command inside it.
  const startedAt = now()
  const remainingMs = (): number => budget - (now() - startedAt)

  const run = (args: readonly string[], timeoutMs: number): Promise<GitOutcome> =>
    new Promise<GitOutcome>(resolve => {
      const stepTimeoutMs = Math.max(1, Math.floor(Math.min(timeoutMs, remainingMs())))
      let stdout = ''
      let stderr = ''
      let issue: string | undefined
      let timedOut = false
      let settled = false
      let child: ChildProcessWithoutNullStreams
      const controller = new AbortController()

      // `unref` so a wedged child cannot hold the Host process open by itself.
      const killTimer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, stepTimeoutMs)
      killTimer.unref?.()
      let lastDataAt = now()
      const silenceTimer = setInterval(() => {
        if (now() - lastDataAt <= SILENCE_LIMIT_MS) return
        timedOut = true
        controller.abort()
      }, SILENCE_POLL_MS)
      silenceTimer.unref?.()
      const finish = (outcome: GitOutcome): void => {
        if (settled) return
        settled = true
        clearTimeout(killTimer)
        clearInterval(silenceTimer)
        resolve(outcome)
      }

      try {
        child = spawnGit('git', args, {
          cwd: request.workspacePath,
          shell: false,
          windowsHide: true,
          signal: controller.signal,
          env: gitEnv(),
        })
      } catch (error) {
        finish({ code: null, signal: null, issue: error instanceof Error ? error.message : String(error), timedOut, output: '' })
        return
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        lastDataAt = now()
        stdout += chunk.toString('utf8')
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        lastDataAt = now()
        stderr += chunk.toString('utf8')
      })
      child.on('error', error => {
        issue = error.message
      })
      const kill = (): void => {
        // Closing the pipes is what unblocks a git child waiting on input, and it
        // is also how a child that ignores the signal is denied its channels.
        try {
          child.stdout?.destroy()
          child.stderr?.destroy()
          child.stdin?.destroy()
        } catch {
          // A stream already torn down is the state we wanted anyway.
        }
        try {
          child.kill('SIGTERM')
        } catch {
          // Nothing left to kill.
        }
      }
      controller.signal.addEventListener('abort', () => {
        kill()
        // A child that never reports `close` would otherwise hold this step — and
        // the whole sync — open forever. Give a real one a moment to arrive with
        // its full output, then settle on what was collected so far.
        const escape = setTimeout(() => {
          if (settled) return
          finish({ code: child.exitCode, signal: null, issue, timedOut, output: normalizeText(`${stdout}${stderr}`) })
        }, 250)
        escape.unref?.()
      }, { once: true })
      child.on('close', (code, signal) => {
        finish({ code, signal, issue, timedOut, output: normalizeText(`${stdout}${stderr}`) })
      })
    })

  /**
   * The workspace's current HEAD, or undefined when there is none. A repository
   * with no commits yet answers `fatal: ambiguous argument 'HEAD'`, which is a
   * precondition rather than a failure, so a non-zero answer simply means
   * "missing". The shape is validated so the commit decision below can never be
   * driven by stray output.
   */
  const readHead = async (): Promise<string | undefined> => {
    const outcome = await run(['rev-parse', 'HEAD'], remainingMs())
    if (outcome.code !== 0) return undefined
    const value = outcome.output.split('\n')[0].trim()
    return /^[0-9a-f]{40}$/.test(value) ? value : undefined
  }

  try {
    if (!isRecord(request) || typeof request.workspacePath !== 'string' || request.workspacePath.trim() === '') {
      result.error = 'workspacePath is required: git cannot run without a workspace to run in'
      return result
    }

    /**
     * The branch to push `refs/for/` on, or why there is none.
     *
     * `rev-parse --abbrev-ref HEAD` prints the same `HEAD` token for two
     * different states, and only one of them is fatal. A detached HEAD has no
     * branch at all; an UNBORN branch (a workspace where `git init` ran but
     * nothing was committed yet) prints the same token and exits 128, and its
     * branch is exactly what HEAD points at — the commit this very sync is about
     * to make will create it. `symbolic-ref` separates the two: it names the
     * branch an unborn HEAD points at, and fails on a detached one. So an unborn
     * branch is accepted (a card may verify a freshly initialised workspace) and
     * a detached HEAD is still refused, without ever inventing a name.
     */
    const resolveBranch = async (): Promise<{ branch: string } | { failure: string; output: string }> => {
      const outcome = await run(['rev-parse', '--abbrev-ref', 'HEAD'], budget)
      const token = outcome.output.split('\n')[0].trim()
      // 0 means a real branch answered; 128 is the detached-or-unborn ambiguity
      // the probe below splits. Anything else is a genuine failure, reported
      // with its own detail so a missing git or an absent workspace is not
      // mislabelled as a detached HEAD.
      const hardFailure = outcome.timedOut || outcome.code === null || outcome.issue !== undefined || (outcome.code !== 0 && outcome.code !== 128)
      if (hardFailure) {
        return {
          failure: failureLine('rev-parse --abbrev-ref HEAD', outcome.code, nonZeroDetail(outcome, budget) ?? 'no exit code'),
          output: outcome.output,
        }
      }
      if (outcome.code === 0 && token !== '' && token !== 'HEAD') return { branch: token }

      const probe = await run(['symbolic-ref', '--short', 'HEAD'], remainingMs())
      const probeToken = probe.output.split('\n')[0].trim()
      if (probe.timedOut || probe.code === null || probe.issue !== undefined) {
        return {
          failure: failureLine('symbolic-ref --short HEAD', probe.code, nonZeroDetail(probe, budget) ?? 'no exit code'),
          output: probe.output,
        }
      }
      if (probe.code === 0 && probeToken !== '' && probeToken !== 'HEAD') return { branch: probeToken }
      return {
        failure: 'rev-parse --abbrev-ref HEAD failed: detached HEAD, no branch to push refs/for/',
        output: outcome.output,
      }
    }

    const resolved = await resolveBranch()
    if ('failure' in resolved) {
      result.error = resolved.failure
      result.output = resolved.output.slice(-MAX_GIT_OUTPUT_BYTES)
      return result
    }
    const branch = resolved.branch
    result.branch = branch
    // Recorded even when `push` is false: the refspec is a function of the
    // branch alone, and it is what the caller shows the human.
    result.refspec = `HEAD:refs/for/${branch}`

    if (request.commit) {
      // Asking git whether there is anything to commit is cheaper and clearer
      // than staging first and decoding a failed commit; the failed-commit path
      // is still handled below, because a hook can reject what `add` staged.
      const statusOutcome = await run(['status', '--porcelain'], remainingMs())
      const statusFailure = nonZeroDetail(statusOutcome, budget)
      if (statusFailure !== undefined) {
        result.error = failureLine('status --porcelain', statusOutcome.code, statusFailure)
        result.output = statusOutcome.output.slice(-MAX_GIT_OUTPUT_BYTES)
        return result
      }
      if (isCleanPorcelain(statusOutcome.output)) {
        result.nothingToCommit = true
      } else {
        // Whether a commit landed is a FACT read from the repository, never an
        // inference from git's prose: a failing hook can print anything, and
        // reading that prose as success would let the board mark a card verified
        // on a commit that does not exist. So the tree is measured, not quoted.
        const beforeHead = await readHead()
        // `add -A` stages the whole workspace, as the contract specifies: the
        // commit means "everything this card's workspace had pending", not a
        // file-level selection nobody asked for.
        const addOutcome = await run(['add', '-A'], remainingMs())
        const addFailure = nonZeroDetail(addOutcome, budget)
        if (addFailure !== undefined) {
          result.error = failureLine('add -A', addOutcome.code, addFailure)
          result.output = addOutcome.output.slice(-MAX_GIT_OUTPUT_BYTES)
          return result
        }
        const commitOutcome = await run(['commit', '-m', request.message], remainingMs())
        // A killed commit cannot be confirmed by reading HEAD: the reading itself
        // would burn the exhausted budget. Report the kill as such.
        if (commitOutcome.code === null || commitOutcome.timedOut) {
          result.error = failureLine('commit', commitOutcome.code, nonZeroDetail(commitOutcome, budget) ?? 'no exit code')
          result.output = commitOutcome.output.slice(-MAX_GIT_OUTPUT_BYTES)
          return result
        }
        const afterHead = await readHead()
        if (afterHead !== undefined && afterHead !== beforeHead) {
          result.committed = true
          result.commitSha = afterHead
        } else if (isNothingToCommit(commitOutcome.output)) {
          // git says it had nothing to do, and HEAD agrees: not a failure.
          result.nothingToCommit = true
        } else {
          const detail = nonZeroDetail(commitOutcome, budget) ?? 'HEAD did not advance, so no commit landed'
          result.error = failureLine('commit', commitOutcome.code, detail)
          result.output = commitOutcome.output.slice(-MAX_GIT_OUTPUT_BYTES)
          return result
        }
      }
    }

    if (request.push) {
      // gerrit reviews land on `refs/for/<branch>`; `<remote>` and the refspec
      // are single argv entries, never interpolated into a shell line.
      const pushOutcome = await run(['push', remote, result.refspec], remainingMs())
      const pushFailure = nonZeroDetail(pushOutcome, budget)
      if (pushFailure !== undefined) {
        result.error = failureLine('push', pushOutcome.code, pushFailure)
        result.output = pushOutcome.output.slice(-MAX_GIT_OUTPUT_BYTES)
        return result
      }
      result.pushed = true
    }

    result.ok = true
    return result
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }
}

export { isCleanPorcelain, isNothingToCommit }

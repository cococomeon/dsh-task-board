/**
 * Real-git checks for the commit + gerrit-push step.
 *
 * Everything here runs against throwaway repositories under `os.tmpdir()`: one
 * work repo per scenario, plus a local `--bare` repo standing in for gerrit. No
 * network, no credentials, no reliance on the machine's git config (the global
 * and system config files are pointed at an empty temp file, and
 * `GIT_TERMINAL_PROMPT=0` keeps a missing credential from becoming a prompt).
 * The scenarios pin the four things the contract fixes — clean tree +
 * `commit: true` is a success with `nothingToCommit`, a dirty tree commits and
 * yields a SHA, a detached HEAD refuses, and the push refspec is
 * `HEAD:refs/for/<branch>` — and then pin the two invariants that must hold
 * even if git itself misbehaves: no force flag ever reaches argv, and nothing in
 * the module builds a shell string.
 *
 * Usage: node test/run.mjs test/git-gerrit.entry.ts
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isCleanPorcelain, isNothingToCommit, runGitSync } from '../src/host/git-gerrit.ts'

const SANDBOX = mkdtempSync(join(tmpdir(), 'tb-git-gerrit-'))
const EMPTY_CONFIG = join(SANDBOX, 'empty-gitconfig')
writeFileSync(EMPTY_CONFIG, '')
// Isolate from whatever the machine has configured: no user identity, no
// core.hooksPath, no credential helper, no `insteadOf` URL rewriting.
process.env.HOME = SANDBOX
process.env.XDG_CONFIG_HOME = SANDBOX
process.env.GIT_CONFIG_GLOBAL = EMPTY_CONFIG
process.env.GIT_CONFIG_SYSTEM = EMPTY_CONFIG
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.GIT_TERMINAL_PROMPT = '0'
process.env.GIT_ASKPASS = ''

const TIMEOUT_MS = 30_000
const BUDGET_MS = 60_000

const print = (label: string, value: unknown): void => {
  console.log(`${label}: ${value === undefined ? '(none)' : JSON.stringify(value)}`)
}

/** Setup git calls only; the module under test is what runs the sync itself. */
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })

/**
 * Nothing downstream can pin the default branch name, so read it back instead of
 * assuming `master` (older git) or `main` (newer git).
 */
const currentBranch = (repo: string): string => git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim()

function makeWorkRepo(name: string, options: { commit?: boolean } = {}): string {
  const dir = join(SANDBOX, name)
  mkdirSync(dir)
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 'test@localhost')
  git(dir, 'config', 'user.name', 'Task Board Test')
  if (options.commit !== false) {
    writeFileSync(join(dir, 'README.md'), 'seed\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'seed')
  }
  return dir
}

function makeBareRepo(name: string): string {
  const dir = join(SANDBOX, name)
  mkdirSync(dir)
  git(dir, 'init', '--bare', '-q')
  return dir
}

/** A `git` that is not there: the error path of every step, with no network. */
const MISSING_REMOTE = join(SANDBOX, 'no-such-remote.git')

try {
  // --- A: a clean tree + commit: true is not a failure ----------------------
  {
    const repo = makeWorkRepo('clean')
    const before = git(repo, 'rev-parse', 'HEAD').trim()
    const result = await runGitSync({ workspacePath: repo, message: 'nothing here (#1)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(result.ok, true)
    assert.equal(result.nothingToCommit, true)
    assert.equal(result.committed, false)
    assert.equal(result.pushed, false)
    assert.equal(result.branch, currentBranch(repo))
    assert.equal(result.refspec, `HEAD:refs/for/${currentBranch(repo)}`)
    assert.equal(result.commitSha, undefined)
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), before)
    // Nothing may be left staged either: a clean tree means git was not touched.
    assert.equal(git(repo, 'status', '--porcelain'), '')
    print('A1 clean tree + commit', result)

    // The `nothing to commit` recognizer itself, including the `add -A` variant
    // that shows up when the only pending changes are ignored files.
    assert.equal(isNothingToCommit('nothing to commit, working tree clean'), true)
    assert.equal(isNothingToCommit('no changes added to commit (use "git add")'), true)
    assert.equal(isNothingToCommit('nothing to commit\n'), true)
    assert.equal(isNothingToCommit('[master 1234567] real commit'), false)
    assert.equal(isNothingToCommit(''), false)
    print('A2 isNothingToCommit', [true, true, true, false, false])
  }

  // --- B: a dirty tree commits and reports the SHA --------------------------
  {
    const repo = makeWorkRepo('dirty')
    writeFileSync(join(repo, 'a.txt'), 'alpha\n')
    writeFileSync(join(repo, 'b.txt'), 'beta\n')
    const result = await runGitSync({ workspacePath: repo, message: 'card title (#42)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(result.ok, true)
    assert.equal(result.committed, true)
    assert.equal(result.nothingToCommit, undefined)
    assert.equal(result.pushed, false)
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    // The reported id comes from `rev-parse HEAD`, so it is the full SHA and
    // resolves on its own — not an abbreviation lifted out of git's summary.
    assert.match(String(result.commitSha), /^[0-9a-f]{40}$/)
    assert.equal(result.commitSha, head)
    assert.equal(git(repo, 'log', '-1', '--pretty=%s').trim(), 'card title (#42)')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    print('B1 dirty tree committed', { sha: result.commitSha, equalsHead: result.commitSha === head, status: '(clean)' })

    // A second sync over the now-clean tree is the "nothingToCommit" path again:
    // the module is idempotent rather than pushing an empty commit.
    const again = await runGitSync({ workspacePath: repo, message: 'card title (#42)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(again.ok, true)
    assert.equal(again.nothingToCommit, true)
    assert.equal(git(repo, 'rev-list', '--count', 'HEAD').trim(), '2')
    print('B2 second sync is a no-op', again)

    // A card title is user text: it must survive as one argv argument.
    const weird = 'feat: "quoted" `backtick` $(subshell) ; and & (#7)'
    writeFileSync(join(repo, 'c.txt'), 'gamma\n')
    const special = await runGitSync({ workspacePath: repo, message: weird, commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(special.ok, true)
    assert.equal(special.committed, true)
    assert.equal(git(repo, 'log', '-1', '--pretty=%s').trim(), weird)
    print('B3 shell metacharacters survive', { committed: special.committed, subject: weird })
  }

  // --- C: ignored-only changes are still "nothing to commit" ----------------
  {
    const repo = makeWorkRepo('ignored')
    writeFileSync(join(repo, '.gitignore'), 'build/\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'add gitignore')
    mkdirSync(join(repo, 'build'))
    writeFileSync(join(repo, 'build', 'artifact.bin'), 'x\n')
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    const result = await runGitSync({ workspacePath: repo, message: 'ignored only (#9)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(result.ok, true)
    assert.equal(result.nothingToCommit, true)
    assert.equal(result.committed, false)
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head)
    print('C1 ignored-only tree', result)
  }

  // --- D: a detached HEAD refuses, with no branch invented -------------------
  {
    const repo = makeWorkRepo('detached')
    git(repo, 'checkout', '-q', '--detach', 'HEAD')
    const head = git(repo, 'rev-parse', 'HEAD').trim()
    const result = await runGitSync({ workspacePath: repo, message: 'detached (#3)', commit: true, push: true, remote: MISSING_REMOTE, timeoutMs: BUDGET_MS })
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.equal(result.pushed, false)
    assert.equal(result.branch, undefined)
    assert.equal(result.refspec, undefined)
    assert.match(String(result.error), /detached HEAD/)
    assert.match(String(result.error), /rev-parse/)
    // It refused before touching the repository at all.
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), head)
    print('D1 detached HEAD', { ok: result.ok, error: result.error })

    // `git rev-parse --abbrev-ref HEAD` really is the literal string `HEAD`
    // there: the refusal is a reading of git's own answer, not a guess.
    assert.equal(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD')
    print('D2 git reports the detached marker', git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim())
  }

  // --- E: refspec shape against a real (local bare) remote -------------------
  {
    const repo = makeWorkRepo('pushy')
    const bare = makeBareRepo('origin.git')
    git(repo, 'remote', 'add', 'origin', bare)
    const branch = currentBranch(repo)
    // Track the upstream so the only reason a push can fail is the refspec, not
    // a local branch that was never pushed.
    git(repo, 'push', '-q', '-u', 'origin', `refs/heads/${branch}`)
    writeFileSync(join(repo, 'd.txt'), 'delta\n')

    const result = await runGitSync({ workspacePath: repo, message: 'push me (#11)', commit: true, push: true, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(result.refspec, `HEAD:refs/for/${branch}`)
    assert.equal(result.branch, branch)
    assert.equal(result.committed, true)
    // Gerrit is what turns `refs/for/<branch>` into a review; git itself stores
    // any `refs/**` name literally, so a plain bare repo accepts this push. That
    // makes the landing place the evidence: the ref the remote received is
    // exactly the review ref, and the branch head was left where this test put
    // it — the refspec was not silently rewritten into a branch push.
    assert.equal(result.ok, true)
    assert.equal(result.pushed, true)
    assert.equal(result.error, undefined)
    print('E1 refspec push', { refspec: result.refspec, ok: result.ok, pushed: result.pushed })

    const bareRefs = git(bare, 'for-each-ref', '--format=%(refname)').trim().split('\n').filter(line => line !== '').sort()
    assert.deepEqual(bareRefs, [`refs/for/${branch}`, `refs/heads/${branch}`])
    const reviewTarget = git(bare, 'rev-parse', `refs/for/${branch}`).trim()
    const branchTarget = git(bare, 'rev-parse', `refs/heads/${branch}`).trim()
    assert.equal(reviewTarget, git(repo, 'rev-parse', 'HEAD').trim())
    assert.notEqual(reviewTarget, branchTarget)
    assert.equal(git(bare, 'symbolic-ref', 'HEAD').trim(), `refs/heads/${branch}`)
    print('E2 bare refs', bareRefs)
    print('E3 review ref vs branch head', { reviewTarget, branchTarget })

    // The same push with a remote that is not there is the failing path, and it
    // still reports the refspec it tried: the caller can show the human what was
    // attempted without a second round of guessing.
    const failed = await runGitSync({ workspacePath: repo, message: 'push me (#11)', commit: false, push: true, remote: MISSING_REMOTE, timeoutMs: BUDGET_MS })
    assert.equal(failed.ok, false)
    assert.equal(failed.pushed, false)
    assert.equal(failed.refspec, `HEAD:refs/for/${branch}`)
    assert.match(String(failed.error), /^push failed \(exit \d+\)/)
    assert.ok(String(failed.output).length > 0)
    print('E4 failing push keeps the refspec', { ok: failed.ok, refspec: failed.refspec, error: failed.error })
  }

  // --- F: a failing push on a non-gerrit remote is a readable failure --------
  {
    const repo = makeWorkRepo('noremote')
    writeFileSync(join(repo, 'e.txt'), 'epsilon\n')
    const result = await runGitSync({ workspacePath: repo, message: 'no remote (#12)', commit: true, push: true, remote: MISSING_REMOTE, timeoutMs: BUDGET_MS })
    assert.equal(result.ok, false)
    assert.equal(result.committed, true)
    assert.notEqual(result.commitSha, undefined)
    assert.equal(result.pushed, false)
    assert.match(String(result.error), /^push failed \(exit \d+\)/)
    assert.ok(String(result.output).length > 0)
    print('F1 missing remote', { committed: result.committed, pushed: result.pushed, error: result.error })

    // `output` is the failing step's tail, truncated to the documented size.
    const long = await runGitSync({ workspacePath: join(SANDBOX, 'does-not-exist'), message: 'x (#13)', commit: false, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(long.ok, false)
    assert.match(String(long.error), /rev-parse --abbrev-ref HEAD/)
    print('F2 missing workspace', { ok: long.ok, error: long.error })
  }

  // --- G: the deadline is enforced ------------------------------------------
  {
    const repo = makeWorkRepo('budget')
    writeFileSync(join(repo, 'f.txt'), 'zeta\n')
    const startedAt = Date.now()
    const result = await runGitSync({ workspacePath: repo, message: 'too slow (#14)', commit: true, push: false, remote: 'origin', timeoutMs: 1 })
    const elapsedMs = Date.now() - startedAt
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.match(String(result.error), /rev-parse --abbrev-ref HEAD failed \((exit \d+|no exit code)\): timed out after 1ms/)
    assert.ok(elapsedMs < 10_000)
    print('G1 timeout', { ok: result.ok, elapsedMs, error: result.error })
  }

  // --- H: the argv invariants, pinned without needing a misbehaving git ------
  {
    const seen: string[][] = []
    // The stub models the two facts the module measures: the branch name, and a
    // HEAD that advances across the commit (two different full SHAs).
    let headReads = 0
    const stubSpawn = (_file: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
      seen.push([...args])
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
      Object.assign(child, { stdout, stderr, stdin: new EventEmitter(), kill: () => true })
      const answer = args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'refs/for-stub\n'
        : args[0] === 'rev-parse' ? `${(headReads += 1) === 1 ? 'a'.repeat(40) : 'b'.repeat(40)}\n`
          : args[0] === 'status' ? ' M a.txt\n'
            : ''
      setImmediate(() => {
        if (answer !== '') stdout.emit('data', Buffer.from(answer))
        child.emit('close', 0, null)
      })
      return child
    }
    const result = await runGitSync(
      { workspacePath: SANDBOX, message: 'stub (#15)', commit: true, push: true, remote: 'origin', timeoutMs: BUDGET_MS },
      { spawn: stubSpawn },
    )
    assert.equal(result.ok, true)
    assert.equal(result.branch, 'refs/for-stub')
    assert.equal(result.refspec, 'HEAD:refs/for/refs/for-stub')
    assert.equal(result.committed, true)
    assert.equal(result.commitSha, 'b'.repeat(40))
    assert.equal(seen.length, 7)
    assert.deepEqual(seen[0], ['rev-parse', '--abbrev-ref', 'HEAD'])
    assert.deepEqual(seen[1], ['status', '--porcelain'])
    assert.deepEqual(seen[2], ['rev-parse', 'HEAD'])
    assert.deepEqual(seen[3], ['add', '-A'])
    assert.deepEqual(seen[4], ['commit', '-m', 'stub (#15)'])
    assert.deepEqual(seen[5], ['rev-parse', 'HEAD'])
    assert.deepEqual(seen[6], ['push', 'origin', 'HEAD:refs/for/refs/for-stub'])
    print('H1 commit+push argv', seen)

    const forced: string[][] = []
    const pushStub = (_file: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
      forced.push([...args])
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
      Object.assign(child, { stdout, stderr, stdin: new EventEmitter(), kill: () => true })
      const answer = args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'release/2.0\n' : ''
      setImmediate(() => {
        if (answer !== '') stdout.emit('data', Buffer.from(answer))
        child.emit('close', 0, null)
      })
      return child
    }
    const pushed = await runGitSync(
      { workspacePath: SANDBOX, message: 'no commit here (#16)', commit: false, push: true, remote: 'upstream', timeoutMs: BUDGET_MS },
      { spawn: pushStub },
    )
    assert.equal(pushed.ok, true)
    assert.equal(pushed.committed, false)
    assert.equal(pushed.pushed, true)
    assert.equal(pushed.refspec, 'HEAD:refs/for/release/2.0')
    assert.deepEqual(forced[1], ['push', 'upstream', 'HEAD:refs/for/release/2.0'])
    print('H2 push argv', forced)

    // The two forbidden spellings, checked on every argv this module built.
    const allArgs = [...seen, ...forced].flat()
    for (const forbidden of ['--force', '--force-with-lease', '-f', '--mirror', '--delete']) {
      assert.equal(allArgs.includes(forbidden), false, `argv must never carry ${forbidden}`)
    }
    assert.equal(forced[1]?.includes('HEAD:refs/for/release/2.0'), true)
    print('H3 no forbidden flag in argv', allArgs)

    // An injected clock proves the stall watchdog is live: a silent child that
    // would otherwise hold the sync open must be killed and reported. The stub
    // mimics a real child — it goes down on SIGTERM and only then reports close.
    const stallingSpawn = (
      _file: string,
      _args: readonly string[],
      options: { signal: AbortSignal },
    ): ChildProcessWithoutNullStreams => {
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
      Object.assign(child, {
        stdout,
        stderr,
        stdin: new EventEmitter(),
        exitCode: null,
        kill: () => true,
      })
      options.signal.addEventListener('abort', () => {
        setImmediate(() => child.emit('close', null, 'SIGTERM'))
      }, { once: true })
      return child
    }
    // The clock runs 1_000x fast: the budget (5s of fake time) must still be
    // remote when the silence threshold (120s of fake time) is crossed, so the
    // watchdog — not the deadline — is what ends this step.
    let clock = 0
    const interval = setInterval(() => { clock += 1_000 }, 1)
    try {
      const stalled = await runGitSync(
        { workspacePath: SANDBOX, message: 'stall (#17)', commit: false, push: false, remote: 'origin', timeoutMs: 5_000 },
        { spawn: stallingSpawn, now: () => clock },
      )
      assert.equal(stalled.ok, false)
      assert.match(String(stalled.error), /timed out/)
      print('H4 stalled child is killed', { ok: stalled.ok, error: stalled.error })
    } finally {
      clearInterval(interval)
    }

    // A dirty-looking tree whose commit still finds nothing to do (git exits
    // non-zero and says so): the contract makes that a success, and it must not
    // be confused with a refused commit — the difference is git's explicit
    // "nothing to commit" report, not the exit code alone.
    const noopStub = (_file: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
      Object.assign(child, { stdout, stderr, stdin: new EventEmitter(), kill: () => true })
      // HEAD answers the same value on both probes, so no commit landed.
      const answer = args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'master\n'
        : args[0] === 'rev-parse' ? `${'c'.repeat(40)}\n`
          : args[1] === '--porcelain' ? ' M a.txt\n'
            : ''
      const refused = args[0] === 'commit'
      setImmediate(() => {
        if (answer !== '') stdout.emit('data', Buffer.from(answer))
        if (refused) stderr.emit('data', Buffer.from('nothing to commit, working tree clean\n'))
        child.emit('close', refused ? 1 : 0, null)
      })
      return child
    }
    const noop = await runGitSync(
      { workspacePath: SANDBOX, message: 'no-op (#18)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS },
      { spawn: noopStub },
    )
    assert.equal(noop.ok, true)
    assert.equal(noop.committed, false)
    assert.equal(noop.nothingToCommit, true)
    assert.equal(noop.commitSha, undefined)
    print('H5 refused-looking commit that had nothing to do', { ok: noop.ok, committed: noop.committed, nothingToCommit: noop.nothingToCommit })
  }

  // --- J: a hook cannot lie about whether a commit landed -------------------
  {
    // The hook prints a reassuring bracketed line and then refuses: prose like
    // this must never be read as success, because the card would be marked
    // verified on a commit that does not exist.
    const failingHook = [
      '#!/bin/sh',
      'echo "[my-hook] checking..."',
      'exit 1',
      '',
    ].join('\n')
    const repo = makeWorkRepo('hook-fails')
    writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), failingHook)
    chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o755)
    writeFileSync(join(repo, 'h.txt'), 'hoox\n')
    const beforeHead = git(repo, 'rev-parse', 'HEAD').trim()
    const result = await runGitSync({ workspacePath: repo, message: 'hook refuses (#20)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(result.ok, false)
    assert.equal(result.committed, false)
    assert.equal(result.commitSha, undefined)
    assert.equal(result.nothingToCommit, undefined)
    assert.equal(result.pushed, false)
    assert.match(String(result.error), /^commit failed \(exit \d+\)/)
    assert.match(String(result.output), /\[my-hook\] checking/)
    // The decisive evidence: the repository did not move.
    assert.equal(git(repo, 'rev-parse', 'HEAD').trim(), beforeHead)
    assert.equal(git(repo, 'log', '-1', '--pretty=%s').trim(), 'seed')
    print('J1 failing hook', { ok: result.ok, committed: result.committed, error: result.error })
    print('J2 HEAD unchanged by the refused commit', { beforeHead, afterHead: git(repo, 'rev-parse', 'HEAD').trim() })
    print('J3 hook script', failingHook.trimEnd())

    // The mirror image: a verbose hook that succeeds. The commit is confirmed by
    // HEAD advancing, so the chatter on stdout is irrelevant either way.
    const chattyHook = [
      '#!/bin/sh',
      'echo "[my-hook] checking..."',
      'echo "[my-hook] 12 files inspected"',
      'exit 0',
      '',
    ].join('\n')
    const chattyRepo = makeWorkRepo('hook-chatty')
    writeFileSync(join(chattyRepo, '.git', 'hooks', 'pre-commit'), chattyHook)
    chmodSync(join(chattyRepo, '.git', 'hooks', 'pre-commit'), 0o755)
    writeFileSync(join(chattyRepo, 'i.txt'), 'iota\n')
    const chattyBefore = git(chattyRepo, 'rev-parse', 'HEAD').trim()
    const chatty = await runGitSync({ workspacePath: chattyRepo, message: 'hook passes (#21)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(chatty.ok, true)
    assert.equal(chatty.committed, true)
    assert.match(String(chatty.commitSha), /^[0-9a-f]{40}$/)
    assert.equal(chatty.commitSha, git(chattyRepo, 'rev-parse', 'HEAD').trim())
    assert.notEqual(chatty.commitSha, chattyBefore)
    assert.equal(git(chattyRepo, 'log', '-1', '--pretty=%s').trim(), 'hook passes (#21)')
    print('J4 verbose passing hook', { ok: chatty.ok, committed: chatty.committed, sha: chatty.commitSha, isFullSha: /^[0-9a-f]{40}$/.test(String(chatty.commitSha)) })
    print('J5 hook script', chattyHook.trimEnd())

    // An unborn branch — `git init` with nothing committed — has no HEAD yet, so
    // the missing-to-present transition is what counts as the commit landing.
    // git answers `HEAD` for this state too, so the branch must be separated from
    // a detached one by `symbolic-ref` rather than by that token.
    const fresh = makeWorkRepo('first-commit', { commit: false })
    let freshBeforeFailed = false
    try {
      git(fresh, 'rev-parse', 'HEAD')
    } catch {
      freshBeforeFailed = true
    }
    assert.equal(freshBeforeFailed, true)
    const unbornName = git(fresh, 'symbolic-ref', '--short', 'HEAD').trim()
    assert.ok(unbornName !== '')
    // The ambiguity this fix exists for: the same `HEAD` token as a detached
    // checkout, but on a non-zero exit.
    let abbrevOnUnborn = { stdout: '', failed: false }
    try {
      abbrevOnUnborn = { stdout: git(fresh, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), failed: false }
    } catch (error) {
      abbrevOnUnborn = { stdout: String((error as { stdout?: string }).stdout ?? '').trim(), failed: true }
    }
    assert.equal(abbrevOnUnborn.failed, true)
    assert.equal(abbrevOnUnborn.stdout, 'HEAD')
    print('J6 unborn branch looks like detached on the surface', { abbrev: abbrevOnUnborn, symbolicRef: unbornName })

    writeFileSync(join(fresh, 'j.txt'), 'kappa\n')
    const first = await runGitSync({ workspacePath: fresh, message: 'first commit (#22)', commit: true, push: false, remote: 'origin', timeoutMs: BUDGET_MS })
    assert.equal(first.ok, true)
    assert.equal(first.committed, true)
    assert.match(String(first.commitSha), /^[0-9a-f]{40}$/)
    assert.equal(first.commitSha, git(fresh, 'rev-parse', 'HEAD').trim())
    assert.equal(first.branch, unbornName)
    assert.equal(first.refspec, `HEAD:refs/for/${unbornName}`)
    assert.equal(git(fresh, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), unbornName)
    print('J7 first commit of an empty repo', { committed: first.committed, branch: first.branch, sha: first.commitSha })
  }

  // --- K: every git child gets a non-interactive environment -----------------
  {
    const seenEnv: NodeJS.ProcessEnv[] = []
    process.env.TB_ENV_MARKER = 'kept'
    const envStub = (_file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams => {
      seenEnv.push({ ...options.env })
      const stdout = new EventEmitter()
      const stderr = new EventEmitter()
      const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
      Object.assign(child, { stdout, stderr, stdin: new EventEmitter(), kill: () => true })
      const answer = args[0] === 'rev-parse' && args[1] === '--abbrev-ref' ? 'master\n' : ''
      setImmediate(() => {
        if (answer !== '') stdout.emit('data', Buffer.from(answer))
        child.emit('close', 0, null)
      })
      return child
    }
    const result = await runGitSync(
      { workspacePath: SANDBOX, message: 'env (#23)', commit: false, push: false, remote: 'origin', timeoutMs: BUDGET_MS },
      { spawn: envStub },
    )
    assert.equal(result.ok, true)
    assert.equal(seenEnv.length, 1)
    for (const env of seenEnv) {
      // The Host has no TTY: without this, git blocks on a prompt it can never
      // receive and the failure surfaces as a timeout instead of a denial.
      assert.equal(env.GIT_TERMINAL_PROMPT, '0')
      // Everything else in the caller's environment is inherited untouched.
      assert.equal(env.TB_ENV_MARKER, 'kept')
      assert.equal(env.HOME, SANDBOX)
    }
    print('K1 child env', { GIT_TERMINAL_PROMPT: seenEnv[0]?.GIT_TERMINAL_PROMPT, TB_ENV_MARKER: seenEnv[0]?.TB_ENV_MARKER, keys: Object.keys(seenEnv[0] ?? {}).length })
  }

  // --- I: the small parsers, pinned directly ---------------------------------
  {
    assert.equal(isCleanPorcelain(''), true)
    assert.equal(isCleanPorcelain('\n'), true)
    assert.equal(isCleanPorcelain(' M a.txt\n'), false)
    assert.equal(isCleanPorcelain('?? new.txt\n'), false)
    print('I1 isCleanPorcelain', ['', '\\n', ' M a.txt', '?? new.txt'].map(isCleanPorcelain))

    // There is deliberately no output-shape decoder left: git's success summary,
    // a hook's chatter and a hook's refusal must not be told apart by prose, so
    // the only recognizer is git's explicit "I had nothing to do" report.
    print('I2 output-shape heuristics', 'removed by contract 3.1')
  }

  console.log('git-gerrit: all assertions passed')
} finally {
  // Every scenario builds its own repo under the sandbox, so one removal covers
  // them all and never touches the fork's own working tree.
  rmSync(SANDBOX, { recursive: true, force: true })
}

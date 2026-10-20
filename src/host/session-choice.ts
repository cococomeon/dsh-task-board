/**
 * The session -> card memory the turn-binding uses: once a user answers the
 * binding modal for a session, later turns of that session stop asking.
 *
 * Storage is a small sidecar of its own (`session-choice.json` in the board's
 * data directory), NOT a field of the ledger. Reasons, in order:
 *
 * - the ledger is the board's shared, versioned document; this file is a
 *   per-user UI preference ("what did I pick for this conversation"), and
 *   folding it in would force a `schemaVersion` bump plus a migration onto
 *   every reader of a document that just passed v6 compatibility;
 * - losing this file costs one extra modal, while corrupting the ledger costs
 *   cards. Keeping them apart keeps that blast radius apart;
 * - every entry is keyed by session id and evicts on its own, so the file never
 *   needs the ledger's repair passes.
 *
 * Writes use the ledger's own durability recipe (temp file → fsync → rename), so
 * a crash mid-write leaves the previous choice file intact instead of a
 * half-written one.
 *
 * @module dsh-task-board/host/session-choice
 */
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.ts'

/** Format version of the sidecar (its own, independent of the ledger's). */
const CHOICE_FORMAT = 1

/**
 * Upper bound on remembered sessions. The map is keyed by session, and a user
 * accumulates sessions forever; the oldest answers are dropped first, so the
 * file stays a few dozen kilobytes without a cleanup pass.
 */
const MAX_CHOICES = 500

/** One remembered answer. */
export interface SessionChoice {
  /** The card this session's turns bind. */
  taskId: string
  /** When the user answered (ms epoch); drives the eviction order. */
  chosenAt: number
}

interface ChoiceDocument {
  version: number
  choices: Record<string, SessionChoice>
}

/**
 * Reads and writes the session -> card memory.
 *
 * Every failure is non-fatal by contract: a missing directory, an unreadable
 * file or a failed write must never stop a turn from answering, so reads fall
 * back to "nothing remembered" and writes are best-effort (the consequence of a
 * lost write is one more modal).
 */
export class SessionChoiceStore {
  /** Absolute path of the sidecar. */
  readonly file: string

  private document: ChoiceDocument

  constructor(
    dir: string = join(dshHome(), 'task-board'),
    private readonly now: () => number = Date.now,
  ) {
    this.file = join(dir, 'session-choice.json')
    this.document = this.load(dir)
  }

  /** The card remembered for one session, if any. */
  get(sessionId: string | undefined): string | undefined {
    if (sessionId === undefined || sessionId === '') return undefined
    return this.document.choices[sessionId]?.taskId
  }

  /** Remember one answer for one session and persist it. */
  set(sessionId: string, taskId: string): void {
    const trimmed = sessionId.trim()
    if (trimmed === '' || taskId.trim() === '') return
    this.document.choices[trimmed] = { taskId, chosenAt: this.now() }
    this.evict()
    this.persist()
  }

  /** Forget one session (kept for an explicit "clear the memory" surface). */
  delete(sessionId: string): void {
    if (this.document.choices[sessionId] === undefined) return
    delete this.document.choices[sessionId]
    this.persist()
  }

  /** Read-only view of what is remembered (tests and diagnostics). */
  entries(): Readonly<Record<string, SessionChoice>> {
    return this.document.choices
  }

  /** Drop the least recently answered sessions beyond the cap. */
  private evict(): void {
    const entries = Object.entries(this.document.choices)
    if (entries.length <= MAX_CHOICES) return
    entries.sort((left, right) => right[1].chosenAt - left[1].chosenAt)
    this.document.choices = Object.fromEntries(entries.slice(0, MAX_CHOICES))
  }

  private load(dir: string): ChoiceDocument {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // A read-only data directory still serves reads from the last parse.
    }
    try {
      if (!existsSync(this.file)) return { version: CHOICE_FORMAT, choices: {} }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      return normalizeDocument(parsed)
    } catch {
      // A corrupt sidecar costs one modal per session; it never blocks a turn.
      return { version: CHOICE_FORMAT, choices: {} }
    }
  }

  /**
   * Replace the sidecar atomically. The temp name carries pid + uuid so two
   * processes (a second board instance over the same home) cannot collide, and
   * the rename is the commit point.
   */
  private persist(): void {
    const dir = dirname(this.file)
    const tmp = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      return
    }
    try {
      const fd = openSync(tmp, 'w')
      try {
        writeFileSync(fd, JSON.stringify(this.document, null, 2), { encoding: 'utf8' })
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(tmp, this.file)
    } catch {
      try {
        unlinkSync(tmp)
      } catch {
        // Nothing to clean up.
      }
    }
  }
}

/** Narrow an unknown parsed document onto the shape this store owns. */
function normalizeDocument(value: unknown): ChoiceDocument {
  if (typeof value !== 'object' || value === null) return { version: CHOICE_FORMAT, choices: {} }
  const record = value as { version?: unknown; choices?: unknown }
  const choices: Record<string, SessionChoice> = {}
  if (typeof record.choices === 'object' && record.choices !== null) {
    for (const [sessionId, entry] of Object.entries(record.choices as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue
      const candidate = entry as { taskId?: unknown; chosenAt?: unknown }
      if (typeof candidate.taskId !== 'string' || candidate.taskId.trim() === '') continue
      const chosenAt = typeof candidate.chosenAt === 'number' && Number.isFinite(candidate.chosenAt) ? candidate.chosenAt : 0
      choices[sessionId] = { taskId: candidate.taskId, chosenAt }
    }
  }
  return { version: CHOICE_FORMAT, choices }
}

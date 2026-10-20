/**
 * The frozen ledger document the self-contained host tests replay.
 *
 * WHY a fixture instead of a copy of the live board: the previous version of
 * `session-link.entry.ts` and `ledger-invariants.entry.ts` read
 * `~/.dsh/task-board/ledger-v2.json`. That made both tests a claim about
 * whatever the user's board happened to contain that minute — they broke the
 * day real cards started carrying `createdBySessionId`, and again once real
 * cards had execution records (`run` refuses a card that was already executed).
 * A test may not depend on data it does not own.
 *
 * The document here is SYNTHETIC and frozen: it is produced by
 * `test/fixtures/generate-fixture.ts` from the real `HostTaskLedger` (so its shape is
 * exactly what the loader writes, never a hand-typed guess), then committed.
 * Regenerating it reproduces the same bytes, which is what makes the pinned
 * digest below meaningful.
 *
 * Two guards, both deliberate:
 * - the sha256 pin makes an accidental edit to the fixture FAIL instead of
 *   silently weakening the assertions that read it;
 * - {@link FIXTURE_TASK_COUNT} makes a *deliberate* regeneration also fail
 *   until the count is re-asserted by hand, so "add one more row" can never
 *   quietly change what "the document loads whole" means.
 *
 * @module dsh-task-board/test/fixtures/ledger-fixture
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Path of the frozen document.
 *
 * Resolved from the working directory, which `node test/run.mjs` always sets to
 * the package root (`test/run.mjs` bundles the entry into a temp file, so
 * `import.meta.url` would point at the bundle, not at this directory). The
 * environment override exists so the same entry can be replayed against another
 * source tree, which is how `ledger-invariants` compares two trees.
 */
export const FIXTURE_LEDGER_PATH = process.env.TB_FIXTURE_LEDGER
  ?? resolve('test/fixtures/ledger-v6-snapshot.json')

/** sha256 of {@link FIXTURE_LEDGER_PATH} as committed. */
export const FIXTURE_LEDGER_SHA256 = '408dbd43221615775b34a9c1f021cf978a4c6e503507cb048b625d3674f36a9b'

/** Rows the document holds, in stored order. */
export const FIXTURE_TASK_IDS = ['fixture-alpha', 'fixture-beta', 'fixture-gamma'] as const

/** Row count the assertions below rely on. */
export const FIXTURE_TASK_COUNT = FIXTURE_TASK_IDS.length

/** The ledger schema this document was written as. */
export const FIXTURE_SCHEMA_VERSION = 6

/** One execution record as stored in the fixture. */
export interface FixtureExecution {
  id: string
  /** Session the run happened in, when the record names one. */
  sessionId?: string
  result?: string
  endedAt?: number
}

/** One row as stored in the fixture (only the fields the tests read). */
export interface FixtureTask {
  id: string
  title: string
  status: string
  executions: FixtureExecution[]
  /** Present exactly on the rows that recorded an origin session. */
  createdBySessionId?: string
  archivedAt?: number
}

/** The parsed frozen document. */
export interface FixtureLedger {
  schemaVersion: number
  revision: number
  tasks: FixtureTask[]
  scheduler: { ledgerId?: string; timeZone?: string; error?: string }
}

/** Digest of one buffer, as the pin uses it. */
export function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Read and verify the frozen document.
 *
 * Verification runs on EVERY read, not once at authoring time: a fixture that
 * drifted must break the test loudly here, before any assertion can pass on a
 * document nobody agreed to.
 * @returns the parsed document plus the raw text that produced it.
 */
export function readFixtureLedger(): { fixture: FixtureLedger; raw: string; digest: string } {
  let raw: string
  try {
    raw = readFileSync(FIXTURE_LEDGER_PATH, 'utf8')
  } catch (error) {
    throw new Error(
      `fixture ledger is missing at ${FIXTURE_LEDGER_PATH} (run the tests from the package root, or regenerate it with \`node test/run.mjs test/fixtures/generate-fixture.ts\`): ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const digest = sha256Of(raw)
  if (digest !== FIXTURE_LEDGER_SHA256) {
    throw new Error(
      `fixture ledger at ${FIXTURE_LEDGER_PATH} is not the committed snapshot: sha256 ${digest} != pinned ${FIXTURE_LEDGER_SHA256}. `
      + 'If the change is intended, regenerate it and re-pin both the digest and FIXTURE_TASK_IDS deliberately.',
    )
  }
  const fixture = JSON.parse(raw) as FixtureLedger
  if (fixture.schemaVersion !== FIXTURE_SCHEMA_VERSION) {
    throw new Error(`fixture ledger schemaVersion ${String(fixture.schemaVersion)} != ${FIXTURE_SCHEMA_VERSION}`)
  }
  const ids = fixture.tasks.map(task => task.id)
  if (JSON.stringify(ids) !== JSON.stringify([...FIXTURE_TASK_IDS])) {
    throw new Error(`fixture ledger rows changed: ${JSON.stringify(ids)} != ${JSON.stringify(FIXTURE_TASK_IDS)}`)
  }
  return { fixture, raw, digest }
}

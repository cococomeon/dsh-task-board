/**
 * Real-path checks for the host half of "task <-> session" linking.
 *
 * Everything here drives the actual HostTaskLedger (bundled through esbuild by
 * test/run.mjs), the actual wire gate in protocol.ts, and the real on-disk v6
 * document copied out of ~/.dsh/task-board — no hand-built TaskRecord stands in
 * for a row the Host produced.
 *
 * Usage: node test/run.mjs test/session-link.entry.ts
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostTaskLedger } from '../src/host-ledger.ts'
import { parseLedger } from '../src/core/store.ts'
import { createTask } from '../src/core/tasks.ts'
import { parseActionEnvelope } from '../src/protocol.ts'

const REAL_LEDGER = process.env.TB_REAL_LEDGER ?? '/Users/lee/.dsh/task-board/ledger-v2.json'
const NOW = 1_760_000_000_000
const SESSION = 'session-84a09234-1111-2222-3333-444455556666'

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')
const tempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix))
const readLedger = (dir: string): { tasks: Record<string, unknown>[] } =>
  JSON.parse(readFileSync(join(dir, 'ledger-v2.json'), 'utf8')) as { tasks: Record<string, unknown>[] }
const rowOf = (dir: string, id: string): Record<string, unknown> => {
  const row = readLedger(dir).tasks.find(task => task.id === id)
  assert.ok(row !== undefined, `task ${id} is missing from ${dir}/ledger-v2.json`)
  return row
}

// --- A: creating with an initiator stamps the field on the record and on disk --
{
  const dir = tempDir('tb-link-a-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  const { state } = ledger.applyRequest(
    'link-a-1',
    { kind: 'create', id: 'card-a', input: { title: 'A', description: 'd', prompt: 'p' } },
    SESSION,
  )
  // state.tasks is the very array host-service puts on TaskBoardSnapshot.tasks.
  assert.equal(state.tasks.find(task => task.id === 'card-a')?.createdBySessionId, SESSION)
  assert.equal(rowOf(dir, 'card-a').createdBySessionId, SESSION)
  console.log('A ok  create+initiator -> record and disk both carry', SESSION)
  console.log('A raw  ' + JSON.stringify(rowOf(dir, 'card-a')))
  ledger.dispose()
}

// --- B: no initiator asserted -> the field is absent, never an empty string ----
{
  const dir = tempDir('tb-link-b-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  const { state } = ledger.applyRequest('link-b-1', { kind: 'create', id: 'card-b', input: { title: 'B', description: 'd', prompt: 'p' } })
  assert.equal(state.tasks.find(task => task.id === 'card-b')?.createdBySessionId, undefined)
  assert.equal('createdBySessionId' in rowOf(dir, 'card-b'), false)
  console.log('B ok  create without initiator -> field absent from record and disk')
  console.log('B raw  ' + JSON.stringify(rowOf(dir, 'card-b')))
  ledger.dispose()
}

// --- C: load -> save -> load keeps the field ----------------------------------
{
  const dir = tempDir('tb-link-c-')
  const first = new HostTaskLedger(dir, () => NOW)
  first.applyRequest('link-c-1', { kind: 'create', id: 'card-c', input: { title: 'C', description: 'd', prompt: 'p' } }, SESSION)
  first.dispose()
  const beforeReload = rowOf(dir, 'card-c')
  const second = new HostTaskLedger(dir, () => NOW)
  const reloaded = second.getTask('card-c')
  assert.equal(reloaded?.createdBySessionId, SESSION)
  console.log('C ok  reload kept createdBySessionId =', reloaded?.createdBySessionId)
  console.log('C raw  before reload: ' + JSON.stringify(beforeReload))
  console.log('C raw  after  reload: ' + JSON.stringify(second.state().tasks.find(task => task.id === 'card-c')))
  second.dispose()
}

// --- D: the real v6 document still loads, whole, and the original is untouched --
{
  const digestBefore = sha256(REAL_LEDGER)
  const source = JSON.parse(readFileSync(REAL_LEDGER, 'utf8')) as { schemaVersion: number; tasks: unknown[] }
  const dir = tempDir('tb-link-d-')
  copyFileSync(REAL_LEDGER, join(dir, 'ledger-v2.json'))
  const ledger = new HostTaskLedger(dir, () => NOW)
  const state = ledger.state()
  assert.equal(state.tasks.length, source.tasks.length)
  assert.equal(state.scheduler.error, undefined)
  for (const task of state.tasks) assert.equal(task.createdBySessionId, undefined)
  console.log(`D ok  copied ${REAL_LEDGER} -> ${join(dir, 'ledger-v2.json')}`)
  console.log(`D ok  source schemaVersion=${source.schemaVersion} tasks=${source.tasks.length}; loaded tasks=${state.tasks.length}; scheduler.error=${String(state.scheduler.error)}`)
  console.log('D ok  createdBySessionId after load:', state.tasks.map(task => String(task.createdBySessionId)).join(', '))
  console.log('D ok  ids kept:', state.tasks.map(task => task.id).join(', '))
  ledger.dispose()
  assert.equal(sha256(REAL_LEDGER), digestBefore)
  console.log('D ok  the real ledger was not written:', digestBefore)
}

// --- E: the origin field is write-once -----------------------------------------
{
  const dir = tempDir('tb-link-e-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  ledger.applyRequest('link-e-1', { kind: 'create', id: 'card-e', input: { title: 'E', description: 'd', prompt: 'p' } }, SESSION)
  const origin = (): unknown => ledger.getTask('card-e')?.createdBySessionId
  const steps: [string, () => void][] = [
    ['update', () => ledger.applyRequest('link-e-2', { kind: 'update', taskId: 'card-e', patch: { title: 'E2', model: 'provider/model' } }, 'session-other')],
    ['move', () => ledger.applyRequest('link-e-3', { kind: 'move', taskId: 'card-e', status: 'done' }, 'session-other')],
    ['archive', () => ledger.applyRequest('link-e-4', { kind: 'archive', taskId: 'card-e' }, 'session-other')],
    ['restore', () => ledger.applyRequest('link-e-5', { kind: 'restore', taskId: 'card-e' }, 'session-other')],
    ['create subtask (no initiator)', () => ledger.applyRequest('link-e-6', { kind: 'create', id: 'card-e-child', input: { title: 'child', description: 'd', prompt: 'p', parentId: 'card-e' } })],
    ['set-parent', () => ledger.applyRequest('link-e-7', { kind: 'set-parent', taskId: 'card-e-child', parentId: 'card-e' }, 'session-other')],
    ['set-schedule', () => ledger.applyRequest('link-e-8', { kind: 'set-schedule', taskId: 'card-e', patch: { enabled: true, cron: '*/5 * * * *' } }, 'session-other')],
  ]
  for (const [label, step] of steps) {
    step()
    assert.equal(origin(), SESSION, `${label} rewrote createdBySessionId`)
    console.log(`E ok  after ${label}: createdBySessionId = ${String(origin())}`)
  }
  assert.equal(ledger.getTask('card-e-child')?.createdBySessionId, undefined)
  console.log('E ok  subtask created without an initiator carries no field')
  ledger.dispose()
}

// --- F: the wire gate bounds the asserted origin without widening update ------
{
  const accepted = parseActionEnvelope({
    requestId: 'link-f-1',
    action: { kind: 'create', id: 'x', input: { title: 't', description: 'd', prompt: 'p', createdBySessionId: SESSION } },
  })
  assert.ok(accepted !== undefined)
  console.log('F ok  create input with createdBySessionId is accepted (the T2 fallback path)')

  const forgedUpdate = parseActionEnvelope({
    requestId: 'link-f-2',
    action: { kind: 'update', taskId: 'x', patch: { createdBySessionId: 'forged' } },
  })
  assert.equal(forgedUpdate, undefined)
  console.log('F ok  update patch carrying createdBySessionId is refused: the field is write-once')

  const nonString = parseActionEnvelope({
    requestId: 'link-f-3',
    action: { kind: 'create', id: 'x', input: { title: 't', description: 'd', prompt: 'p', createdBySessionId: 42 } },
  })
  assert.equal(nonString, undefined)
  const tooLong = parseActionEnvelope({
    requestId: 'link-f-4',
    action: { kind: 'create', id: 'x', input: { title: 't', description: 'd', prompt: 'p', createdBySessionId: 's'.repeat(257) } },
  })
  assert.equal(tooLong, undefined)
  console.log('F ok  a non-string or over-long asserted origin is refused by the gate')
}

// --- H: precedence — the acting session always outranks the asserted one -------
{
  const dir = tempDir('tb-link-h-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  const originOf = (id: string): unknown => ledger.getTask(id)?.createdBySessionId
  const input = (id: string, asserted?: unknown) => ({
    kind: 'create' as const,
    id,
    input: { title: id, description: 'd', prompt: 'p', ...(asserted === undefined ? {} : { createdBySessionId: asserted as string }) },
  })

  ledger.applyRequest('link-h-1', input('h-initiator-only'), 'session-initiator')
  assert.equal(originOf('h-initiator-only'), 'session-initiator')

  ledger.applyRequest('link-h-2', input('h-asserted-only', 'session-asserted'))
  assert.equal(originOf('h-asserted-only'), 'session-asserted')

  ledger.applyRequest('link-h-3', input('h-both', 'session-asserted'), 'session-initiator')
  assert.equal(originOf('h-both'), 'session-initiator')

  ledger.applyRequest('link-h-4', input('h-blank', '   '))
  assert.equal(originOf('h-blank'), undefined)
  assert.equal('createdBySessionId' in rowOf(dir, 'h-blank'), false)

  ledger.applyRequest('link-h-5', input('h-trimmed', '  session-padded  '))
  assert.equal(originOf('h-trimmed'), 'session-padded')
  console.log('H ok  initiator-only=%s asserted-only=%s both=%s blank=%s trimmed=%s',
    String(originOf('h-initiator-only')),
    String(originOf('h-asserted-only')),
    String(originOf('h-both')),
    String(originOf('h-blank')),
    String(originOf('h-trimmed')))
  ledger.dispose()
}

// --- I: the browser-local create path (no transport) stamps it too -------------
{
  const task = createTask({ title: 'I', description: 'd', prompt: 'p', createdBySessionId: `  ${SESSION}  ` }, NOW, 'card-i')
  assert.equal(task.createdBySessionId, SESSION)
  const blank = createTask({ title: 'I', description: 'd', prompt: 'p', createdBySessionId: '   ' }, NOW, 'card-i2')
  assert.equal(blank.createdBySessionId, undefined)
  console.log('I ok  createTask honors the asserted origin (trimmed) and drops a blank one')
}

// --- J: an exported board re-imports with its origins intact -------------------
{
  const row = {
    id: 'imported-1',
    title: 'J',
    description: 'd',
    prompt: 'p',
    status: 'todo',
    createdAt: NOW,
    updatedAt: NOW,
    executions: [],
    createdBySessionId: SESSION,
  }
  const parsed = parseActionEnvelope({ requestId: 'link-j-1', action: { kind: 'import', sourceId: 'export-1', tasks: [row] } })
  assert.ok(parsed !== undefined)
  assert.equal((parsed.action as { tasks: { createdBySessionId?: string }[] }).tasks[0]?.createdBySessionId, SESSION)
  const malformed = parseActionEnvelope({
    requestId: 'link-j-2',
    action: { kind: 'import', sourceId: 'export-2', tasks: [{ ...row, createdBySessionId: 42 }] },
  })
  assert.equal(malformed, undefined)
  const dir = tempDir('tb-link-j-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  ledger.applyRequest(parsed.requestId, parsed.action)
  assert.equal(ledger.getTask('imported-1')?.createdBySessionId, SESSION)
  console.log('J ok  import keeps createdBySessionId and refuses a non-string one; stored =', String(rowOf(dir, 'imported-1').createdBySessionId))
  ledger.dispose()
}

// --- K: a malformed stored value never costs the task row ----------------------
{
  const row = {
    id: 'k-1', title: 'K', description: 'd', prompt: 'p', status: 'todo',
    createdAt: NOW, updatedAt: NOW, executions: [], createdBySessionId: 42,
  }
  const tasks = parseLedger(JSON.stringify([row]))
  assert.equal(tasks.length, 1, 'a malformed createdBySessionId must not drop the row')
  assert.equal(tasks[0]?.createdBySessionId, undefined)
  const blank = parseLedger(JSON.stringify([{ ...row, createdBySessionId: '   ' }]))
  assert.equal(blank.length, 1)
  assert.equal(blank[0]?.createdBySessionId, undefined)
  const kept = parseLedger(JSON.stringify([{ ...row, createdBySessionId: SESSION }]))
  assert.equal(kept[0]?.createdBySessionId, SESSION)
  console.log('K ok  rows kept through parseLedger: numeric -> dropped, blank -> dropped, string -> kept')
}

// --- G: the wire envelope the browser posts is what stamps the record ----------
{
  const dir = tempDir('tb-link-g-')
  const ledger = new HostTaskLedger(dir, () => NOW)
  // Byte-for-byte the body src/client/host-api.ts posts for a create action.
  const body = JSON.stringify({
    requestId: 'link-g-1',
    action: { kind: 'create', id: 'card-g', input: { title: 'G', description: 'd', prompt: 'p' } },
    initiator: SESSION,
  })
  const parsed = parseActionEnvelope(JSON.parse(body))
  assert.ok(parsed !== undefined)
  // host-service.applyBoardAction does exactly this, plus withInheritedWorkspace.
  const snapshotLike = ledger.applyRequest(parsed.requestId, parsed.action, parsed.initiator)
  assert.equal(snapshotLike.state.tasks.find(task => task.id === 'card-g')?.createdBySessionId, SESSION)
  console.log('G ok  wire body -> parseActionEnvelope -> ledger produced', String(rowOf(dir, 'card-g').createdBySessionId))
  ledger.dispose()
}

console.log('ALL CHECKS PASSED')

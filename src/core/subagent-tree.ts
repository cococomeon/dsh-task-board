/**
 * The agent family tree, as far as settling a card is concerned.
 *
 * WHY this exists: a turn's `turn/end` says the PARENT agent stopped talking —
 * it says nothing about the agents that turn spawned. A subagent runs its own
 * loop and its own turns, so a card settled on the parent's `turn/end` is
 * settled while the work it asked for is still running (observed: a card marked
 * "done" while its subagent was mid-run).
 *
 * The tree is read from session headers, where `dsh-subagent` writes
 * `parentSession: <parent header id>` and `origin: 'subagent'` when it opens a
 * child session, so the relation is available for every depth — a subagent may
 * spawn its own subagent.
 *
 * Deliberately a pure function over plain state: the caller keeps the live map
 * (from `agent/status`), and this decides only "is any descendant still busy",
 * which is the whole predicate a settle needs.
 *
 * @module @linxin666/dsh-client-ui-task-board/core/subagent-tree
 */

/** One agent the Host has heard from, keyed by its session id. */
export interface LiveAgentState {
  /** The agent's session id. */
  sessionId: string
  /** The session that spawned it; absent for a root agent. */
  parentSession?: string
  /** Whether its loop is currently `running` (false once it went `idle`). */
  busy: boolean
}

/**
 * Whether any agent BELOW `root` in the spawn tree is still busy.
 *
 * `root` itself is excluded on purpose: the caller asks this question exactly
 * when root's own turn just ended, so root is idle (or was never running) and
 * counting it would make the answer always true.
 *
 * The walk is a breadth-first traversal over a children index, guarded by a
 * visited set that starts at `root`: session metadata is persisted data, so a
 * corrupted `parentSession` pointing at a descendant (or at the root) must not
 * turn this into an infinite loop. Anything unreachable from `root` is not its
 * family and does not count.
 * @param root - session id whose subtree is inspected (not counted itself).
 * @param agents - every known agent state; duplicates are merged.
 * @returns true when some descendant of `root` is busy.
 */
export function hasBusyDescendant(root: string, agents: Iterable<LiveAgentState>): boolean {
  if (root === '') return false
  const children = new Map<string, string[]>()
  const busy = new Map<string, boolean>()
  for (const agent of agents) {
    const id = agent.sessionId
    if (typeof id !== 'string' || id === '') continue
    // Duplicates: a busy report anywhere outranks an idle one, because a stale
    // idle record must never be what lets a card settle early.
    busy.set(id, (busy.get(id) ?? false) || agent.busy)
    const parent = agent.parentSession
    if (typeof parent !== 'string' || parent === '') continue
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [id])
    else if (!siblings.includes(id)) siblings.push(id)
  }
  const visited = new Set<string>([root])
  const queue: string[] = [root]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const child of children.get(current) ?? []) {
      // Cycles (and a child naming root as its own parent) end here.
      if (visited.has(child)) continue
      visited.add(child)
      if (busy.get(child) === true) return true
      queue.push(child)
    }
  }
  return false
}

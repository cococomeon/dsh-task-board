/**
 * Sidebar reveal for a session jump.
 *
 * Selecting a session does not make it visible in the left sidebar: the
 * session list groups rows under their workspace, a workspace group can be
 * collapsed, a group can hold more rows than it renders, and the whole sidebar
 * column can be closed. A jump that only selects the session therefore leaves
 * the operator with a conversation and no visible row — this module is the rule
 * that repairs the view afterwards.
 *
 * It is deliberately applied on every entry point of a jump (the card double
 * click and the conversation title-bar button), not only where the operator
 * noticed it: the requirement is "whenever we jump to a session, show it".
 *
 * The work is split in three passes because the sidebar re-renders after each
 * repair: the first pass expands the group that hides the row, the second lets
 * that render land and retries, and the third scrolls the row into view once it
 * exists. Each pass is guarded by a pending token so a repeated request for the
 * same session cannot queue the same DOM helper twice.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/session-reveal
 */

/**
 * Where a revealed session row lives in the DOM. Both are written by
 * `@deepseek-ai/dsh-client-ui-workspace`: the group header carries
 * `data-row-key="workspace:<workspaceId>"` and every session row carries
 * `data-row-key="session:<sessionId>"`.
 */
const WORKSPACE_ROW = 'workspace'
const SESSION_ROW = 'session'

/** The sidebar fold-state the reveal needs; a closed column shows no rows at all. */
export interface RevealLayoutFace {
  /** Close or open the sidebar column (the service toggles, it cannot set). */
  toggleSidebar?: () => void
}

/** Navigation and the two DOM repairs the reveal performs. */
export interface RevealDeps {
  /** The layout service (`ctx.layout`), when the layout plugin is loaded. */
  layout: () => RevealLayoutFace | undefined
  /** The workspace UI service (`ctx.uiWorkspace`), when ui-workspace is loaded. */
  workspace: () => { openSession: (id: string) => void } | undefined
  /** Schedule one frame of work; the browser default wraps `setTimeout`. */
  later?: (fn: () => void) => void
}

/** One reveal in flight: which session and workspace, and how much work already ran. */
interface PendingReveal {
  sessionId: string
  workspaceId: string | undefined
  expanded: boolean
  scrolled: boolean
}

const BROWSER_LATER = (fn: () => void): void => {
  setTimeout(fn, 0)
}

/**
 * Open the sidebar column when it is closed.
 *
 * Detection reads the rendered frame rather than the layout store: the
 * service publishes only a toggle, and the frame marks a closed column with
 * `data-sidebar-collapsed` on the grid container. When the shell is not
 * reachable (another host renders the plugin) nothing is toggled — guessing
 * would close a sidebar that is already open.
 */
function openSidebar(layout: RevealLayoutFace | undefined): void {
  if (typeof layout?.toggleSidebar !== 'function') return
  const frame = document.querySelector('[data-sidebar-collapsed]')
  if (frame !== null) layout.toggleSidebar()
}

/**
 * Ask the sidebar to reveal one session row; the browser finishes the job a
 * frame or two later, once the group renders the row.
 * @param deps - navigation, layout, and the timer seam.
 * @returns one function per click: call it once after opening the session,
 * passing the workspace the session belongs to when the caller knows it.
 */
export function createSessionReveal(deps: RevealDeps): (sessionId: string, workspaceId?: string) => void {
  const later = deps.later ?? BROWSER_LATER
  let pending: PendingReveal | undefined

  const sessionRow = (sessionId: string): Element | null =>
    document.querySelector(`[data-row-key="${SESSION_ROW}:${sessionId}"]`)

  /**
   * Scroll the row into view exactly once. The row's own reveal is a React
   * effect keyed on the reveal identity, so it only fires when the sidebar
   * itself owns the navigation; a jump from outside arrives at an already
   * selected row and nothing would move. This is that missing scroll — one
   * helper per pending reveal, so a remote scroll cannot fight the row for
   * focus.
   */
  function scroll(): void {
    const current = pending
    pending = undefined
    if (current === undefined || current.scrolled) return
    current.scrolled = true
    const row = sessionRow(current.sessionId)
    row?.scrollIntoView({ block: 'nearest' })
  }

  /**
   * Expand the branch that holds the row. The session row is rendered only by
   * an expanded group, so while it is missing the row's owning group is still
   * collapsed.
   *
   * The caller usually knows the workspace the session belongs to, and that is
   * the only group opened — a reveal must not scatter the operator's fold
   * state, which is theirs. When it is unknown the search falls back to opening
   * the collapsed groups; a collapsed group renders no rows, so the target
   * cannot be told apart from the DOM alone and the fallback is the only
   * option that still lands the operator on a visible row.
   */
  function expand(): void {
    const current = pending
    if (current === undefined || current.expanded) return
    if (sessionRow(current.sessionId) !== null) {
      current.expanded = true
      return
    }
    const browser = document.querySelector('[role="tree"], [role="treeitem"]')
    if (browser === null) return
    const folded = current.workspaceId === undefined
      ? [...document.querySelectorAll(`[data-row-key^="${WORKSPACE_ROW}:"]`)]
      : [document.querySelector(`[data-row-key="${WORKSPACE_ROW}:${current.workspaceId}"]`)]
          .filter((row): row is Element => row !== null)
    for (const row of folded) {
      if (row.getAttribute('aria-expanded') === 'false') (row as HTMLElement).click()
    }
  }

  return (sessionId: string, workspaceId?: string): void => {
    // A second jump supersedes the first: the reveal is about showing the row
    // the operator is now looking at, not about a session they left.
    pending = { sessionId, workspaceId, expanded: false, scrolled: false }
    openSidebar(deps.layout())
    deps.workspace()?.openSession(sessionId)
    later(() => {
      expand()
      later(() => {
        expand()
        later(scroll)
      })
    })
  }
}

/**
 * Mark a session row so a reveal can find it again.
 * @param sessionId - session the row shows.
 * @returns the selector for that row.
 */
export function sessionRowSelector(sessionId: string): string {
  return `[data-row-key="${SESSION_ROW}:${sessionId}"]`
}

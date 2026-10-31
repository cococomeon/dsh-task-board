/**
 * Sidebar reveal for a session jump.
 *
 * Selecting a session does not make it visible in the left sidebar. Three
 * independent mechanisms can each hide the row:
 *
 * 1. the sidebar column can be closed;
 * 2. the row's workspace group can be collapsed;
 * 3. a group renders a bounded window of rows behind a 「展开其余 N 个会话」
 *    button, so an older session in a busy workspace has no DOM row at all.
 *
 * Mechanism 3 is why expanding groups is not enough: `默认工作区` holds 128
 * sessions and renders 6, so its 95th session needs ~18 clicks. The sidebar
 * itself already solves this for its own search: `openSearchResult()` stores a
 * reveal id, `SessionTree` then expands every ancestor group, lifts that
 * group's row limit to `Infinity`, scrolls the row into view and clears the id.
 * That path is what this module drives — typing the session into the sidebar
 * search and activating the matching result — because the alternative (clicking
 * the overflow button in a loop, or expanding every group) either cannot reach
 * the row or destroys the operator's fold state.
 *
 * Applied on every entry point of a jump (card double-click and the
 * conversation title-bar button), not only where the operator noticed it: the
 * requirement is "whenever we jump to a session, show it".
 *
 * @module @linxin666/dsh-client-ui-task-board/client/session-reveal
 */

/**
 * Where a revealed session row lives in the DOM. Written by
 * `@deepseek-ai/dsh-client-ui-workspace`: group headers carry
 * `data-row-key="workspace:<workspaceId>"` and session rows carry
 * `data-row-key="session:<sessionId>"`. Search results reuse the very same
 * `SessionNodeItem`, so the session key holds in both modes.
 */
const WORKSPACE_ROW = 'workspace'
const SESSION_ROW = 'session'

/** The sidebar search box, the seat the reveal types into. */
const SEARCH_INPUT = 'input[placeholder="搜索会话名称"]'

/** The collapsed-search toggle, which must be opened before the box accepts text. */
const SEARCH_TOGGLE = 'button[aria-label="搜索会话"]'

/**
 * One search result row. Results are NOT session-tree rows: the sidebar renders
 * them from a separate component with its own classes and no `data-row-key`, so
 * the target cannot be found by id in search mode — the query does the
 * selection and the first row is the best match.
 */
const SEARCH_RESULT = '[role="treeitem"][class*="searchResultRow"]'

/** The sidebar fold-state the reveal needs; a closed column shows no rows at all. */
export interface RevealLayoutFace {
  /** Close or open the sidebar column (the service toggles, it cannot set). */
  toggleSidebar?: () => void
}

/** Navigation and the DOM repairs the reveal performs. */
export interface RevealDeps {
  /** The layout service (`ctx.layout`), when the layout plugin is loaded. */
  layout: () => RevealLayoutFace | undefined
  /** The workspace UI service (`ctx.uiWorkspace`), when ui-workspace is loaded. */
  workspace: () => { openSession: (id: string) => void } | undefined
  /**
   * The session's display title, used as the search query.
   *
   * The sidebar matches the query against the session title and the workspace
   * label — never against the session id — so a reveal that typed the id would
   * always search for nothing. The title has to come from the catalog, because
   * it is derived there and appears nowhere in the card.
   */
  title: (sessionId: string) => string | undefined
  /** Schedule one frame of work; the browser default wraps `setTimeout`. */
  later?: (fn: () => void) => void
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

/** Set a React-controlled input's value so the sidebar's onChange sees it. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Whether the sidebar search box is open and accepting the query. */
function searchIsOpen(input: HTMLInputElement): boolean {
  return input.tabIndex === 0 && input.getBoundingClientRect().width > 0
}

/**
 * Ask the sidebar to reveal one session row.
 * @param deps - navigation, layout, and the timer seam.
 * @returns one function per jump: call it once after opening the session,
 * passing the workspace when the caller knows it (informational only — the
 * sidebar derives the owning group from the row itself).
 */
export function createSessionReveal(deps: RevealDeps): (sessionId: string, workspaceId?: string) => void {
  const later = deps.later ?? BROWSER_LATER

  // The jump whose row still has to be shown. Cleared once the row is on
  // screen, so a repeat jump for the same session re-drives the search.
  let pending: string | undefined

  const sessionRow = (sessionId: string): Element | null =>
    document.querySelector(`[data-row-key="${SESSION_ROW}:${sessionId}"]`)

  /**
   * Search for the pending session by title and activate its result row.
   *
   * The row only exists in the DOM once it is either inside the rendered window
   * of an expanded group or matched by the search — and for a session past the
   * window it is never the former. Driving the search hands the job to the
   * sidebar's own reveal, which expands the ancestors, lifts the group's row
   * cap to infinity, scrolls the row into view and clears its reveal id.
   *
   * The match is deliberately title-based and takes the first result: results
   * carry no session id, so the query is what selects the row. The title is
   * exact enough in practice, and the activation is what the operator asked
   * for — landing on the wrong row is visible and recoverable, while never
   * landing at all is the bug this module exists to fix.
   */
  function reveal(): void {
    const sessionId = pending
    if (sessionId === undefined) return
    const row = sessionRow(sessionId)
    if (row !== null) {
      // Already rendered: the sidebar opened it, or it was inside the window.
      row.scrollIntoView({ block: 'nearest' })
      pending = undefined
      return
    }
    const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT)
    if (input === null) return
    if (!searchIsOpen(input)) {
      document.querySelector<HTMLElement>(SEARCH_TOGGLE)?.click()
      return
    }
    const query = deps.title(sessionId)
    if (query === undefined || query === '') return
    if (input.value !== query) {
      setInputValue(input, query)
      return
    }
    const result = document.querySelector<HTMLElement>(SEARCH_RESULT)
    if (result === null) return
    result.click()
    pending = undefined
  }

  return (sessionId: string, _workspaceId?: string): void => {
    // A second jump supersedes the first: the reveal is about showing the row
    // the operator is now looking at, not about a session they left.
    pending = sessionId
    openSidebar(deps.layout())
    deps.workspace()?.openSession(sessionId)
    // Three passes: the search toggle needs a render before the input is open,
    // the query needs one before results arrive, and activation needs one for
    // the sidebar's reveal to run.
    later(() => {
      reveal()
      later(() => {
        reveal()
        later(reveal)
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

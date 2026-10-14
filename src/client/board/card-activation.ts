/**
 * Card activation: one pointer click opens the task detail, two pointer clicks
 * jump to the card's session — and which one happened is only knowable after
 * the second click has had time to arrive. This module owns that single rule
 * (the window, the cancel, the jump), so the card stays a renderer and the
 * timing is unit-testable without a DOM or a rendering library.
 *
 * Keyboard activation of the stretched open control is deliberately outside
 * the window: a keyboard user presses Enter once, means one thing, and must
 * not wait 250ms for a second press that cannot be a double click.
 *
 * @module @linxin666/dsh-client-ui-task-board/client/board/card-activation
 */

/** How long a lone pointer click waits for a second one before opening the detail. */
export const CARD_DOUBLE_CLICK_MS = 250

/** What an activation does; the card supplies these, this module decides when. */
export interface CardActivationSink {
  /** Open the card's task detail. */
  openDetail(): void
  /** Navigate to the card's linked session. */
  openSession(sessionId: string): void
  /** A double click found no linked session: report it instead of navigating. */
  notifyNoSession(): void
}

/** Timer seam; the default wraps the browser timers. */
export interface CardActivationClock {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const BROWSER_CLOCK: CardActivationClock = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

/** The activation rule for one card. */
export interface CardActivation {
  /**
   * A pointer click on the card body. The first one starts the window; a
   * second inside it makes the pair one jump.
   * @param sessionId - the card's linked session (undefined when it has none).
   */
  click(sessionId: string | undefined): void
  /** Keyboard activation of the open control: opens the detail at once. */
  activate(): void
  /** Drop a window that is still open (the card unmounted before it expired). */
  cancel(): void
}

/**
 * Build the activation rule for one card.
 * @param sink - what an activation does.
 * @param clock - timer seam; defaults to the browser timers.
 * @param windowMs - the double-click window.
 */
export function createCardActivation(
  sink: CardActivationSink,
  clock: CardActivationClock = BROWSER_CLOCK,
  windowMs: number = CARD_DOUBLE_CLICK_MS,
): CardActivation {
  let pending: unknown
  const cancel = (): void => {
    if (pending === undefined) return
    clock.clear(pending)
    pending = undefined
  }
  return {
    click(sessionId) {
      if (pending === undefined) {
        pending = clock.set(() => {
          pending = undefined
          sink.openDetail()
        }, windowMs)
        return
      }
      // The pair is one gesture: the detail never opens, and the jump happens
      // exactly here — once, on the second click.
      cancel()
      if (sessionId === undefined) sink.notifyNoSession()
      else sink.openSession(sessionId)
    },
    activate() {
      cancel()
      sink.openDetail()
    },
    cancel,
  }
}

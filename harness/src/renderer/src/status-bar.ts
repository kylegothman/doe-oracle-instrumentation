import type { Subject } from '../../shared/subjects'
import type { TrialEvent } from '../../shared/trials'

/**
 * What the session status bar (story #39) shows about the current trial,
 * worked out from the trial events the main process pushes. Kept apart
 * from the component so it can be tested without a window.
 *
 * - idle: no trial has run in this window yet;
 * - running: a trial is under way, from `started` until it ends;
 * - ready: the last trial ended (saved, failed, cancelled, or aborted) and
 *   the harness can run the next one.
 */
export interface BarState {
  phase: 'idle' | 'running' | 'ready'
  subject: Subject | null
  questionNumber: number | null
  /**
   * Milliseconds since the trial started, as of `anchorAt`, while the time
   * counts. Once the answer is complete it is the measured response time,
   * begin to end. Null when no trial is running.
   */
  elapsedMs: number | null
  /**
   * When `elapsedMs` was measured, by the window's clock, while the time is
   * still counting. Null once it stops: the answer is complete and waits
   * for the Tester's confirmation, so the time no longer grows.
   */
  anchorAt: number | null
}

export const IDLE: BarState = { phase: 'idle', subject: null, questionNumber: null, elapsedMs: null, anchorAt: null }

/** The bar after one trial event, received at `receivedAt` (Date.now() in the window). */
export function nextBarState(event: TrialEvent, receivedAt: number): BarState {
  const trial = { subject: event.subject, questionNumber: event.questionNumber }
  switch (event.status) {
    case 'started':
    case 'awaiting_submit':
    case 'first_response':
      return { phase: 'running', ...trial, elapsedMs: event.elapsedMs, anchorAt: receivedAt }
    case 'awaiting_confirmation': {
      // The controller stopped the clock at the end of the answer, and the
      // event carries the detected begin and end: from here the time shown
      // is the measured response, not the time since the trial started.
      const measured = event.beginMs !== undefined && event.endMs !== undefined ? event.endMs - event.beginMs : event.elapsedMs
      return { phase: 'running', ...trial, elapsedMs: measured, anchorAt: null }
    }
    case 'completed':
    case 'failed':
    case 'cancelled':
    case 'aborted':
      return { phase: 'ready', subject: null, questionNumber: null, elapsedMs: null, anchorAt: null }
  }
}

/** The elapsed time to show at `now`: counting while anchored, fixed once stopped, null with no trial. */
export function elapsedAt(state: BarState, now: number): number | null {
  if (state.elapsedMs === null) return null
  return state.anchorAt === null ? state.elapsedMs : state.elapsedMs + Math.max(0, now - state.anchorAt)
}

/** Minutes, seconds, and hundredths, as in the design: 9377 ms is "00:09.38". Null is "—". */
export function formatElapsed(ms: number | null): string {
  if (ms === null) return '—'
  const hundredths = Math.round(ms / 10)
  const minutes = Math.floor(hundredths / 6000)
  const seconds = Math.floor((hundredths % 6000) / 100)
  const rest = hundredths % 100
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(rest).padStart(2, '0')}`
}

/** The badge at the right of the bar. */
export function badgeFor(state: BarState): { label: string; tone: 'neutral' | 'accent' } {
  switch (state.phase) {
    case 'idle':
      return { label: 'Idle', tone: 'neutral' }
    case 'running':
      return { label: 'Running', tone: 'accent' }
    case 'ready':
      return { label: 'Ready', tone: 'neutral' }
  }
}

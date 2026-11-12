import type { FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import type { Subject } from '../../shared/subjects'

/** What an adapter reads back once the subject has answered. */
export interface CapturedAnswer {
  /** The answer as shown, without citations, buttons, or other chrome. */
  text: string
  /** Citation lines as shown, for example "paper.pdf · p.3". Empty when the subject shows none. */
  citations: string[]
  /** Where the answer was read from, usually the page URL. */
  sourceUrl?: string
}

/**
 * The contract between the Trial Controller and every system under test
 * (Detailed Design 3.2, story #25). The controller holds one adapter per
 * subject for the whole session and runs each trial as
 *
 *   start → waitForFirstResponse → waitForCompletion → captureAnswer → dispose
 *
 * stopping early when the adapter reports a failure, the trial's timer
 * expires, or the Tester cancels. Timestamps are epoch milliseconds from
 * the system clock, in whichever process read it (see TimingService).
 *
 * Rules for an implementation:
 * - start() does everything needed to ask the question: open or focus the
 *   subject, type the question, and submit it. It resolves with begin, the
 *   moment the question was submitted. For the Oracle that is when the
 *   search request leaves the page; for Copilot and Google it will be the
 *   Tester's submit (#34, #36).
 * - waitForFirstResponse() and waitForCompletion() resolve with the moment
 *   the first part of the answer and the whole answer appeared.
 * - captureAnswer() reads the answer as shown. An empty text is allowed;
 *   the controller records it as EMPTY_ANSWER.
 * - onFailure(handler) registers the one handler the adapter calls as soon
 *   as it observes a failure: an error status, a request or page load that
 *   failed, an empty answer. The controller registers it before each
 *   start(). Reporting a failure does not replace rejecting the pending
 *   promise; the adapter may do both, and the controller acts on the signal.
 * - dispose() releases everything the current trial holds: listeners,
 *   timers, pending waits (which reject). It is called at the end of every
 *   trial, however it ended, must be safe to call at any time and more than
 *   once, and leaves the adapter ready for the next start(). It must return
 *   quickly: the harness has to be ready for the next trial within
 *   5 seconds of a failure (NFR-3).
 *
 * TODO(#5): the Copilot adapter (E4) implements this interface.
 * TODO(#6): the Google adapter (E5) implements this interface.
 */
export interface SubjectAdapter {
  readonly subject: Subject
  start(question: Question): Promise<number>
  waitForFirstResponse(): Promise<number>
  waitForCompletion(): Promise<number>
  captureAnswer(): Promise<CapturedAnswer>
  onFailure(handler: (signal: FailureSignal) => void): void
  dispose(): Promise<void>
}

import type { FailureSignal } from '../../shared/failures'
import type { Question } from '../../shared/questions'
import type { Subject } from '../../shared/subjects'

/** Rejects a pending wait when dispose() ends the trial it belonged to. The controller ignores it. */
export class AdapterDisposedError extends Error {
  override readonly name = 'AdapterDisposedError'
}

/**
 * Something the Tester must do before the trial can go on, reported by an
 * adapter between its steps. The controller forwards it to the window as a
 * trial event with the same status.
 */
export interface AdapterNotice {
  /** The question is typed and the subject waits for the Tester to submit it. */
  status: 'awaiting_submit'
  message: string
}

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
 *   Resolving a step and reporting a failure in the same tick is fine: the
 *   controller still records that step's timestamp on the failed trial.
 * - dispose() releases everything the current trial holds: listeners,
 *   timers, pending waits (which reject). It is called at the end of every
 *   trial, however it ended, must be safe to call at any time and more than
 *   once, and leaves the adapter ready for the next start(). It must return
 *   quickly: the harness has to be ready for the next trial within
 *   5 seconds of a failure (NFR-3).
 * - onNotice(handler), optional, registers the handler for notices to the
 *   Tester, such as "press Enter" once the question is typed. An adapter
 *   that drives its subject itself (the Oracle) has nothing to say and
 *   leaves it out.
 *
 * TODO(#6): the Google adapter (E5) implements this interface.
 */
export interface SubjectAdapter {
  readonly subject: Subject
  start(question: Question): Promise<number>
  waitForFirstResponse(): Promise<number>
  waitForCompletion(): Promise<number>
  captureAnswer(): Promise<CapturedAnswer>
  onFailure(handler: (signal: FailureSignal) => void): void
  onNotice?(handler: (notice: AdapterNotice) => void): void
  dispose(): Promise<void>
}

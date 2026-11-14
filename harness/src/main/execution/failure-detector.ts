import { FailureType, type FailureSignal } from '../../shared/failures'

/**
 * Turns what an adapter or the trial clock observed into one of the four
 * failure types (Detailed Design 3.3, story #28), or null when the signal
 * describes no failure. The rules, in the order they are applied:
 *
 * 1. timedOut → TIMEOUT.
 * 2. An HTTP status of 400 or higher from the subject's endpoint, or an
 *    error the subject showed in place of an answer → ERROR_RESPONSE.
 * 3. A connection or navigation error (the request failed before any
 *    response, or the page could not be loaded) → UNREACHABLE. This covers
 *    the Flask backend being down while the frontend still loads.
 * 4. A completed answer that is empty or only whitespace → EMPTY_ANSWER.
 *
 * A refusal to answer ("I can't help with that") is an answer, not a
 * failure, so nothing here looks at what the text says.
 */
export class FailureDetector {
  classify(signal: FailureSignal): FailureType | null {
    if (signal.timedOut) {
      return FailureType.TIMEOUT
    }
    if (signal.httpStatus !== undefined && signal.httpStatus >= 400) {
      return FailureType.ERROR_RESPONSE
    }
    if (signal.errorMessage !== undefined && signal.errorMessage.trim().length > 0) {
      return FailureType.ERROR_RESPONSE
    }
    if (signal.networkError !== undefined && signal.networkError.trim().length > 0) {
      return FailureType.UNREACHABLE
    }
    if (signal.answerText !== undefined && this.isEmptyAnswer(signal.answerText)) {
      return FailureType.EMPTY_ANSWER
    }
    return null
  }

  /** True for an answer with no visible text at all. */
  isEmptyAnswer(text: string): boolean {
    return text.trim().length === 0
  }
}

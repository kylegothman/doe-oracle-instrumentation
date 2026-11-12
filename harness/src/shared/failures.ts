/**
 * The four ways a trial can fail (Detailed Design 3.3, story #28). A refusal
 * to answer is an answer, not a failure, so there is no type for it.
 */
export enum FailureType {
  /** The subject's endpoint answered with an HTTP status of 400 or higher. */
  ERROR_RESPONSE = 'ERROR_RESPONSE',
  /**
   * The subject could not be reached: a connection or navigation error,
   * including a backend that is down behind a frontend that still loads.
   */
  UNREACHABLE = 'UNREACHABLE',
  /** No answer within the subject's time limit. */
  TIMEOUT = 'TIMEOUT',
  /** The subject completed with an answer that is empty or only whitespace. */
  EMPTY_ANSWER = 'EMPTY_ANSWER',
}

/**
 * What an adapter observed, or what the controller's timer reports. The
 * FailureDetector turns a signal into a FailureType, or into null when the
 * signal describes no failure. Fields are optional because each source
 * knows only its own part: a network error has no HTTP status, an empty
 * answer has no network error.
 */
export interface FailureSignal {
  /** Status of the response from the subject's endpoint, when one arrived. */
  httpStatus?: number
  /** Why the request or the page load failed, for example net::ERR_CONNECTION_REFUSED. */
  networkError?: string
  /** True when the trial's timer expired. */
  timedOut: boolean
  /** The completed answer's text, for the empty-answer rule. */
  answerText?: string
}

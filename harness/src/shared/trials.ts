import type { Subject } from './subjects'

/** How a saved trial ended. */
export enum TrialStatus {
  SUCCESS = 'SUCCESS',
  /** One of the four FailureTypes; see the trial's failure record. */
  FAILED = 'FAILED',
  /** TODO(#37): E5 sets this when the Tester reports that Google showed no answer. Nothing sets it yet. */
  NO_ANSWER_FOUND = 'NO_ANSWER_FOUND',
}

/**
 * One saved trial. Field names are camelCase here and snake_case in the
 * trials table (trial_id, test_number, ...). Timestamps are ISO 8601 UTC
 * with milliseconds; durations are whole milliseconds. A failed trial keeps
 * whichever marks it reached before it failed and null for the rest.
 */
export interface Trial {
  trialId: string
  /** Sequential number across the whole database, assigned when saved. */
  testNumber: number
  sessionId: string
  /** Subject code plus date, for example DOE_ORACLE-2026-11-12. */
  dataSetName: string
  subject: Subject
  questionNumber: number
  status: TrialStatus
  beginTs: string | null
  firstResponseTs: string | null
  endTs: string | null
  /** begin to end. */
  responseMs: number | null
  /** begin to first response. */
  firstResponseMs: number | null
  answerText: string | null
  citations: string[]
}

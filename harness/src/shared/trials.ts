import type { FailureType } from './failures'
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

/**
 * Where the running trial is, pushed to the renderer on the trial:event
 * channel as the Trial Controller moves through it. How a status maps to
 * the TrialStatus the trial is saved with:
 * - started and first_response are progress; nothing is saved yet;
 * - completed means the trial was saved as SUCCESS;
 * - failed means the trial was saved as FAILED, and failureType says why;
 * - cancelled (the Tester cancelled it) and aborted (the harness itself
 *   could not run it, for example Chromium is missing) are never saved.
 */
export type TrialEventStatus = 'started' | 'first_response' | 'completed' | 'failed' | 'cancelled' | 'aborted'

export interface TrialEvent {
  trialId: string
  subject: Subject
  questionNumber: number
  status: TrialEventStatus
  /** Milliseconds since the trial started, by the controller's clock. */
  elapsedMs: number
  /** What went wrong, for failed and aborted. */
  message?: string
  /** Set with status failed. */
  failureType?: FailureType
}

/**
 * A save that failed in the database and is waiting for a retry, as the
 * renderer sees it (errors:list). The full record stays in the main
 * process's ErrorLog; the page only needs enough to show what is waiting.
 */
export interface FailedWriteSummary {
  id: string
  operation: 'saveTrial' | 'saveExpert' | 'saveExpertResponse'
  /** What was being saved, for example "DOE Oracle trial, question 3". */
  description: string
  /** The error from the most recent attempt. */
  error: string
  /** When the first attempt failed, ISO 8601 UTC with milliseconds. */
  failedAt: string
}

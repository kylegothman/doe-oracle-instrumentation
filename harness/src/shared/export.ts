import type { Subject } from './subjects'

/**
 * Which records an export includes (Detailed Design Figure 10, UC-6). Every
 * field narrows the export; null means no limit on it, so an all-null
 * filter exports everything.
 */
export interface RecordFilter {
  /** Only this session's trials and the expert answers entered during it. */
  sessionId: string | null
  /**
   * Only records from this moment on (inclusive), as an ISO 8601 UTC
   * timestamp with milliseconds. A trial counts from its begin timestamp, or
   * its session's start if it failed before beginning; an expert answer
   * counts from when it was entered.
   */
  from: string | null
  /** Only records before this moment (exclusive), in the same format as from. */
  to: string | null
  /** Only one subject's trials, or 'EXPERT' for only the expert's answers. */
  subject: Subject | 'EXPERT' | null
}

/** A filter that exports everything. */
export const ALL_RECORDS: Readonly<RecordFilter> = { sessionId: null, from: null, to: null, subject: null }

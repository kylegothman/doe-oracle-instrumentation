import type { Expert, ResponseSource } from './experts'

/**
 * What crosses the IPC bridge when the Researcher enters an expert's record
 * on the Expert Responses page (UC-5). The main process's
 * ExpertRecordService applies the rules; a save answers with a result, not
 * a thrown error, because an error keeps only its message across the
 * bridge and the page needs to know which field is wrong.
 */

/** An expert as the Researcher entered it. */
export interface ExpertInput {
  /** The expert to update, or null to create a new one. */
  expertId: string | null
  /** The only personal detail the harness stores (NFR-7). */
  name: string
  source: ResponseSource
  /** When the questions were sent, ISO 8601 UTC with milliseconds. Required: null is refused. */
  outreachTs: string | null
  /** When the first answer arrived, ISO 8601 UTC with milliseconds; null until the reply arrives. */
  firstAnswerTs: string | null
}

/** The fields of the expert record a save can refuse. */
export type ExpertField = 'name' | 'source' | 'outreachTs' | 'firstAnswerTs'

/** What saving an expert did: saved it, or saved nothing and says which field is wrong. */
export type SaveExpertResult =
  | { status: 'SAVED'; expert: Expert }
  | { status: 'INVALID'; field: ExpertField; message: string }

const ISO_UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Epoch milliseconds of an ISO 8601 UTC timestamp with milliseconds, the
 * only form the harness stores (2026-10-06T14:00:00.000Z), or null when the
 * text is anything else, including a date that does not exist.
 */
export function parseUtcTimestamp(value: string): number | null {
  if (!ISO_UTC_MILLIS.test(value)) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) || new Date(ms).toISOString() !== value ? null : ms
}

/**
 * The expert's turnaround: first answer minus outreach, in milliseconds
 * (story #42). Null when either time is missing or unreadable. It may be
 * negative; ExpertRecordService refuses that before anything is saved.
 */
export function turnaroundMs(outreachTs: string | null, firstAnswerTs: string | null): number | null {
  if (outreachTs === null || firstAnswerTs === null) return null
  const outreach = parseUtcTimestamp(outreachTs)
  const firstAnswer = parseUtcTimestamp(firstAnswerTs)
  return outreach === null || firstAnswer === null ? null : firstAnswer - outreach
}

/**
 * Checks the shape of an ExpertInput that crossed the IPC bridge: every
 * field present with the right type. Returns what is wrong, or null. What
 * the values must be (a name, an outreach time, the order of the times) is
 * ExpertRecordService's to judge.
 */
export function validateExpertInput(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'The expert record is missing'
  const { expertId, name, source, outreachTs, firstAnswerTs } = value as Partial<ExpertInput>
  if (expertId !== null && (typeof expertId !== 'string' || expertId.trim() === '')) {
    return 'The expert id must be a non-empty string, or null for a new expert'
  }
  if (typeof name !== 'string') return 'The expert name must be text'
  if (typeof source !== 'string') return 'The response source must be text'
  if (outreachTs !== null && typeof outreachTs !== 'string') return 'The outreach time must be a timestamp or null'
  if (firstAnswerTs !== null && typeof firstAnswerTs !== 'string') return 'The first answer time must be a timestamp or null'
  return null
}

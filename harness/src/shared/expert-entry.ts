import type { Expert, ExpertResponse, ResponseSource } from './experts'

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

/** One answer as the Researcher entered it. */
export interface ExpertAnswerInput {
  expertId: string
  /** One of the standard questions, 1 to 12. */
  questionNumber: number
  /** The answer as pasted. Blank lines at the very start and end are dropped on save; nothing else changes. */
  answerText: string
}

/** The fields of an answer a save can refuse. */
export type ExpertAnswerField = 'questionNumber' | 'answerText'

/** What saving an answer did: saved it, or saved nothing and says which field is wrong. */
export type SaveExpertAnswerResult =
  | { status: 'SAVED'; saved: ExpertResponse }
  | { status: 'INVALID'; field: ExpertAnswerField; message: string }

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

/**
 * An answer as it is stored: exactly as pasted, apart from blank lines
 * (empty, or only spaces and tabs) at the very start and the very end.
 * The first line's indentation, blank lines between paragraphs, and the
 * line endings inside the text are kept.
 */
export function trimBlankLines(text: string): string {
  return text.replace(/^(?:[^\S\r\n]*\r?\n)+/, '').replace(/(?:\r?\n[^\S\r\n]*)+$/, '')
}

/**
 * Checks the shape of an ExpertAnswerInput that crossed the IPC bridge.
 * Returns what is wrong, or null. Whether the question exists and the
 * answer has any text is ExpertRecordService's to judge.
 */
export function validateExpertAnswerInput(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'The expert answer is missing'
  const { expertId, questionNumber, answerText } = value as Partial<ExpertAnswerInput>
  if (typeof expertId !== 'string' || expertId.trim() === '') return 'The expert id must be a non-empty string'
  if (typeof questionNumber !== 'number') return 'The question number must be a number'
  if (typeof answerText !== 'string') return 'The answer must be text'
  return null
}

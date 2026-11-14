import type { ResponseSource } from '../../shared/experts'
import type { FailureType } from '../../shared/failures'
import { Subject, SUBJECT_LABELS } from '../../shared/subjects'
import type { ExportRecord } from './metrics-repository'

/**
 * One row of the TestLogV3 sheet: the 11 columns of Tom's layout, in order
 * (UC-6, NFR-8). null means the cell is left empty.
 */
export interface TestLogRow {
  testNumber: number
  questionNumber: number
  /** The subject's display name, or "Expert". */
  testSubject: string
  /** "log data set name": subject code plus date for trials, EXPERT-<date> for the expert. */
  dataSetName: string
  answerText: string | null
  /** Total response time; Google's page-load time; the expert's turnaround on one row. */
  responseMs: number | null
  /** "User Email": the session ID, so no personal information is exported (NFR-7). */
  userEmail: string
  beginTs: string | null
  endTs: string | null
  keywords: string | null
  /** Bytes / 1024, rounded to 2 decimals. */
  sizeKb: number
}

/**
 * The supplementary sheet's row for the same Test #: the fields TestLogV3
 * has no column for. null means the cell is left empty.
 */
export interface SupplementaryRow {
  testNumber: number
  firstResponseMs: number | null
  pageLoadMs: number | null
  timeToAnswerMs: number | null
  sourceUrl: string | null
  /** Citations joined with "; ", or null when there are none. */
  citations: string | null
  failureType: FailureType | null
  responseSource: ResponseSource | null
}

/** Test Subject on every expert row. */
export const EXPERT_SUBJECT = 'Expert'

/** Both rows for every record, in the records' order (Test # order from listExportRecords). */
export function toExportRows(records: readonly ExportRecord[]): { main: TestLogRow[]; extra: SupplementaryRow[] } {
  const turnaroundRows = turnaroundTestNumbers(records)
  return {
    main: records.map((record) => toTestLogRow(record, turnaroundRows)),
    extra: records.map(toSupplementaryRow),
  }
}

/**
 * The Test # of each expert's lowest-numbered question in these records:
 * the one row per expert that carries the turnaround (UC-6).
 */
function turnaroundTestNumbers(records: readonly ExportRecord[]): Set<number> {
  const lowest = new Map<string, { questionNumber: number; testNumber: number }>()
  for (const record of records) {
    if (record.kind !== 'EXPERT') continue
    const current = lowest.get(record.expert.expertId)
    if (!current || record.response.questionNumber < current.questionNumber) {
      lowest.set(record.expert.expertId, { questionNumber: record.response.questionNumber, testNumber: record.testNumber })
    }
  }
  return new Set([...lowest.values()].map((entry) => entry.testNumber))
}

function toTestLogRow(record: ExportRecord, turnaroundRows: ReadonlySet<number>): TestLogRow {
  if (record.kind === 'TRIAL') {
    const { trial } = record
    return {
      testNumber: record.testNumber,
      questionNumber: trial.questionNumber,
      testSubject: SUBJECT_LABELS[trial.subject],
      dataSetName: trial.dataSetName,
      answerText: trial.answerText,
      // Google gives a page of links, not an answer, so its response time is the page load (UC-3).
      responseMs: trial.subject === Subject.GOOGLE ? trial.pageLoadMs : trial.responseMs,
      userEmail: trial.sessionId,
      beginTs: trial.beginTs,
      endTs: trial.endTs,
      keywords: trial.keywords,
      sizeKb: toKb(trial.sizeBytes),
    }
  }
  const { expert, response } = record
  const carriesTurnaround = turnaroundRows.has(record.testNumber)
  return {
    testNumber: record.testNumber,
    questionNumber: response.questionNumber,
    testSubject: EXPERT_SUBJECT,
    dataSetName: expertDataSetName(expert.firstAnswerTs),
    answerText: response.answerText,
    responseMs: carriesTurnaround ? expert.turnaroundMs : null,
    userEmail: response.sessionId,
    beginTs: carriesTurnaround ? expert.outreachTs : null,
    endTs: carriesTurnaround ? expert.firstAnswerTs : null,
    keywords: response.keywords,
    sizeKb: toKb(response.sizeBytes),
  }
}

function toSupplementaryRow(record: ExportRecord): SupplementaryRow {
  if (record.kind === 'TRIAL') {
    const { trial } = record
    return {
      testNumber: record.testNumber,
      firstResponseMs: trial.firstResponseMs,
      pageLoadMs: trial.pageLoadMs,
      timeToAnswerMs: trial.timeToAnswerMs,
      sourceUrl: trial.sourceUrl,
      citations: trial.citations.length > 0 ? trial.citations.join('; ') : null,
      failureType: trial.failure?.type ?? null,
      responseSource: null,
    }
  }
  return {
    testNumber: record.testNumber,
    firstResponseMs: null,
    pageLoadMs: null,
    timeToAnswerMs: null,
    sourceUrl: null,
    citations: null,
    failureType: null,
    responseSource: record.expert.source,
  }
}

/**
 * EXPERT plus the UTC date of the expert's first answer, like a trial's
 * subject-plus-date name; just EXPERT while that date is not entered.
 */
function expertDataSetName(firstAnswerTs: string | null): string {
  return firstAnswerTs ? `EXPERT-${firstAnswerTs.slice(0, 10)}` : 'EXPERT'
}

/** Size Kbytes: bytes / 1024, rounded to 2 decimals. */
function toKb(bytes: number): number {
  return Math.round((bytes / 1024) * 100) / 100
}

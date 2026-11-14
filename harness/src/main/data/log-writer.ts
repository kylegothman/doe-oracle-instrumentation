import type { SupplementaryRow, TestLogRow } from './export-rows'

/**
 * The write contract every export format implements (Detailed Design
 * Figure 9). ExportService picks the writer for the chosen format, so a new
 * format means one new class. It returns the paths it wrote, since a format
 * may need more than one file (CSV writes the supplementary rows separately).
 */
export interface LogWriter {
  write(main: readonly TestLogRow[], extra: readonly SupplementaryRow[], filePath: string): Promise<string[]>
}

/**
 * Tom's TestLogV3 headers, exactly as in his TestLogV3.xlsx, including the
 * trailing spaces in "Question Number " and "Test Subject ". Shared by every
 * writer so the formats cannot drift apart.
 */
export const TESTLOG_V3_HEADERS = [
  'Test #',
  'Question Number ',
  'Test Subject ',
  'log data set name',
  'Answer Text',
  'Response Milliseconds',
  'User Email',
  'Begin Timestamp',
  'End Timestamp',
  'Keywords',
  'Size Kbytes',
] as const

/** Headers of the supplementary sheet or file, keyed by Test #. */
export const SUPPLEMENTARY_HEADERS = [
  'Test #',
  'Time to First Response Milliseconds',
  'Page Load Milliseconds',
  'Time to Answer Milliseconds',
  'Source URL',
  'Citations',
  'Failure Type',
  'Response Source',
] as const

/** A TestLogV3 row's cells, in header order. null is an empty cell. */
export function testLogCells(row: TestLogRow): Array<string | number | null> {
  return [
    row.testNumber,
    row.questionNumber,
    row.testSubject,
    row.dataSetName,
    row.answerText,
    row.responseMs,
    row.userEmail,
    row.beginTs,
    row.endTs,
    row.keywords,
    row.sizeKb,
  ]
}

/** A supplementary row's cells, in header order. null is an empty cell. */
export function supplementaryCells(row: SupplementaryRow): Array<string | number | null> {
  return [
    row.testNumber,
    row.firstResponseMs,
    row.pageLoadMs,
    row.timeToAnswerMs,
    row.sourceUrl,
    row.citations,
    row.failureType,
    row.responseSource,
  ]
}

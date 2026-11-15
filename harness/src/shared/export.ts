import { isSubject, type Subject } from './subjects'

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

/** The export formats the Export Page offers (UC-6). */
export enum ExportFormat {
  /** Tom's TestLogV3 workbook, with a supplementary sheet. */
  TESTLOG_V3_XLSX = 'TESTLOG_V3_XLSX',
  /** The same columns as CSV, with the supplementary columns in a second file. */
  CSV = 'CSV',
}

/** What the Export Page asks for. The save location is chosen in the main process's save dialog. */
export interface ExportRequest {
  filter: RecordFilter
  format: ExportFormat
}

/**
 * How an export ended:
 * - EXPORTED: the file(s) were written;
 * - NOTHING_TO_EXPORT: no record matched the filter, so no file was written (UC-6 E1);
 * - CANCELLED: the Tester closed the save dialog without choosing a location;
 * - WRITE_FAILED: the file could not be written, for example because it is
 *   open in Excel; the Tester can export again to another location (UC-6 E2).
 * No outcome changes any stored record.
 */
export type ExportStatus = 'EXPORTED' | 'NOTHING_TO_EXPORT' | 'CANCELLED' | 'WRITE_FAILED'

export interface ExportResult {
  ok: boolean
  status: ExportStatus
  /** The files written, empty unless EXPORTED. */
  filePaths: string[]
  /** Rows exported (one per trial or expert answer), 0 unless EXPORTED. */
  rowCount: number
  /** What to tell the Tester when the export did not happen; null when it did or was cancelled. */
  error: string | null
}

/** True when value is one of the export formats. Use it on anything that crossed the IPC bridge. */
export function isExportFormat(value: unknown): value is ExportFormat {
  return value === ExportFormat.TESTLOG_V3_XLSX || value === ExportFormat.CSV
}

/**
 * Checks an ExportRequest that crossed the IPC bridge. Returns what is
 * wrong with it, or null when it is valid.
 */
export function validateExportRequest(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return 'The export request is missing'
  const { filter, format } = value as Partial<ExportRequest>
  if (!isExportFormat(format)) return `Unknown export format "${String(format)}"`
  if (typeof filter !== 'object' || filter === null) return 'The export filter is missing'
  const { sessionId, from, to, subject } = filter as Partial<RecordFilter>
  if (sessionId !== null && typeof sessionId !== 'string') return 'The session filter must be a session ID or null'
  for (const [name, bound] of [
    ['from', from],
    ['to', to],
  ] as const) {
    if (bound !== null && (typeof bound !== 'string' || Number.isNaN(Date.parse(bound)))) {
      return `The ${name} date must be an ISO 8601 timestamp or null`
    }
  }
  if (subject !== null && subject !== 'EXPERT' && !isSubject(subject)) return `Unknown subject "${String(subject)}"`
  return null
}

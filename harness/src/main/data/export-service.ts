import { ExportFormat, type ExportPreview, type ExportRequest, type ExportResult, type RecordFilter } from '../../shared/export'
import { toExportRows } from './export-rows'
import type { LogWriter } from './log-writer'
import type { MetricsRepository } from './metrics-repository'

/** Asks the Tester where to save. Resolves with the chosen path, or null if they cancelled. */
export type ChooseSavePath = (suggestedName: string, format: ExportFormat) => Promise<string | null>

/** File extension per format, for the suggested name and the save dialog. */
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  [ExportFormat.TESTLOG_V3_XLSX]: 'xlsx',
  [ExportFormat.CSV]: 'csv',
}

export interface ExportServiceDeps {
  repository: Pick<MetricsRepository, 'listExportRecords'>
  writers: ReadonlyMap<ExportFormat, LogWriter>
  /** For the suggested file name; the system clock unless a test sets it. */
  now?: () => Date
}

/**
 * Runs an export (UC-6, SD-6): reads the matching records, leaving out
 * superseded expert answers, maps them to TestLogV3 and supplementary rows,
 * asks where to save, and hands the rows to the writer for the chosen
 * format. It only reads stored records, so no outcome changes them.
 */
export class ExportService {
  private readonly now: () => Date

  constructor(private readonly deps: ExportServiceDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  async export(request: ExportRequest, chooseSavePath: ChooseSavePath): Promise<ExportResult> {
    const writer = this.deps.writers.get(request.format)
    if (!writer) {
      return failed('WRITE_FAILED', `Export to ${request.format} is not available yet.`)
    }

    // E1: checked before the save dialog, so the Tester is not asked for a location for nothing.
    const records = this.deps.repository.listExportRecords(request.filter)
    if (records.length === 0) {
      return failed('NOTHING_TO_EXPORT', 'Nothing to export: no trials or expert answers match this filter.')
    }

    const filePath = await chooseSavePath(this.suggestedName(request.format), request.format)
    if (filePath === null) {
      return { ok: false, status: 'CANCELLED', filePaths: [], rowCount: 0, error: null }
    }

    const { main, extra } = toExportRows(records)
    let filePaths: string[]
    try {
      filePaths = await writer.write(main, extra, filePath)
    } catch (error) {
      // E2: usually the file is open in Excel or the folder is read-only.
      const reason = error instanceof Error ? error.message : String(error)
      return failed(
        'WRITE_FAILED',
        `Could not write ${filePath} (${reason}). If the file is open in Excel, close it, or export again to another location.`,
      )
    }
    console.log(`[export] Wrote ${main.length} rows to ${filePaths.join(', ')}`)
    return { ok: true, status: 'EXPORTED', filePaths, rowCount: main.length, error: null }
  }

  /**
   * Counts what an export with this filter would include, by the same query
   * the export runs, so the count on the Export Page always matches the
   * rows written.
   */
  preview(filter: RecordFilter): ExportPreview {
    const records = this.deps.repository.listExportRecords(filter)
    const trials = records.filter((record) => record.kind === 'TRIAL').length
    return { trials, expertAnswers: records.length - trials }
  }

  /** TestLog-<local date>.<extension>, for example TestLog-2026-11-14.xlsx. */
  suggestedName(format: ExportFormat): string {
    const now = this.now()
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((part) => String(part).padStart(2, '0')).join('-')
    return `TestLog-${date}.${EXPORT_EXTENSIONS[format]}`
  }
}

function failed(status: 'NOTHING_TO_EXPORT' | 'WRITE_FAILED', error: string): ExportResult {
  return { ok: false, status, filePaths: [], rowCount: 0, error }
}

import ExcelJS from 'exceljs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_RECORDS, ExportFormat, type ExportRequest } from '../../shared/export'
import { ResponseSource } from '../../shared/experts'
import { Subject } from '../../shared/subjects'
import { TrialStatus } from '../../shared/trials'
import { ExportService, type ChooseSavePath } from './export-service'
import type { LogWriter } from './log-writer'
import { MetricsRepository, type ExportRecord, type NewTrial } from './metrics-repository'
import { TestLogV3Writer } from './testlog-v3-writer'

const request: ExportRequest = { filter: ALL_RECORDS, format: ExportFormat.TESTLOG_V3_XLSX }

function sampleTrial(overrides: Partial<NewTrial> = {}): NewTrial {
  return {
    trialId: 'trial-1',
    sessionId: 'session-a',
    dataSetName: 'DOE_ORACLE-2026-11-14',
    subject: Subject.DOE_ORACLE,
    questionNumber: 1,
    status: TrialStatus.SUCCESS,
    beginTs: '2026-11-14T11:00:00.000Z',
    firstResponseTs: '2026-11-14T11:00:00.300Z',
    endTs: '2026-11-14T11:00:01.000Z',
    responseMs: 1_000,
    firstResponseMs: 300,
    answerText: 'An answer.',
    citations: [],
    ...overrides,
  }
}

const oneRecord = [{ kind: 'TRIAL', testNumber: 1, trial: { ...sampleTrial(), testNumber: 1 } }] as ExportRecord[]

describe('ExportService', () => {
  let writer: LogWriter & { write: ReturnType<typeof vi.fn> }
  let chooseSavePath: ReturnType<typeof vi.fn> & ChooseSavePath

  const service = (records: ExportRecord[] = oneRecord): ExportService =>
    new ExportService({
      repository: { listExportRecords: () => records },
      writers: new Map([[ExportFormat.TESTLOG_V3_XLSX, writer]]),
      now: () => new Date(2026, 10, 14, 9, 30),
    })

  beforeEach(() => {
    writer = { write: vi.fn(async (_main, _extra, filePath: string) => [filePath]) }
    chooseSavePath = vi.fn(async () => 'C:\\Exports\\TestLog-2026-11-14.xlsx') as typeof chooseSavePath
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks where to save with a dated name, writes the rows there, and reports the file and row count', async () => {
    const result = await service().export(request, chooseSavePath)

    expect(chooseSavePath).toHaveBeenCalledWith('TestLog-2026-11-14.xlsx', ExportFormat.TESTLOG_V3_XLSX)
    expect(writer.write).toHaveBeenCalledWith(
      [expect.objectContaining({ testNumber: 1, testSubject: 'DOE Oracle' })],
      [expect.objectContaining({ testNumber: 1 })],
      'C:\\Exports\\TestLog-2026-11-14.xlsx',
    )
    expect(result).toEqual({
      ok: true,
      status: 'EXPORTED',
      filePaths: ['C:\\Exports\\TestLog-2026-11-14.xlsx'],
      rowCount: 1,
      error: null,
    })
  })

  it('passes the filter to the repository', async () => {
    const listExportRecords = vi.fn(() => oneRecord)
    const filter = { ...ALL_RECORDS, sessionId: 's2', subject: Subject.COPILOT }
    await new ExportService({ repository: { listExportRecords }, writers: new Map([[ExportFormat.TESTLOG_V3_XLSX, writer]]) }).export(
      { filter, format: ExportFormat.TESTLOG_V3_XLSX },
      chooseSavePath,
    )

    expect(listExportRecords).toHaveBeenCalledWith(filter)
  })

  it('reports nothing to export without asking for a location or writing a file (UC-6 E1)', async () => {
    const result = await service([]).export(request, chooseSavePath)

    expect(result).toEqual({
      ok: false,
      status: 'NOTHING_TO_EXPORT',
      filePaths: [],
      rowCount: 0,
      error: 'Nothing to export: no trials or expert answers match this filter.',
    })
    expect(chooseSavePath).not.toHaveBeenCalled()
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('writes nothing when the Tester cancels the save dialog', async () => {
    chooseSavePath.mockResolvedValueOnce(null)

    const result = await service().export(request, chooseSavePath)

    expect(result).toEqual({ ok: false, status: 'CANCELLED', filePaths: [], rowCount: 0, error: null })
    expect(writer.write).not.toHaveBeenCalled()
  })

  it('reports a file that cannot be written and suggests another location (UC-6 E2)', async () => {
    writer.write.mockRejectedValueOnce(new Error("EBUSY: resource busy or locked, open 'C:\\Exports\\TestLog-2026-11-14.xlsx'"))

    const result = await service().export(request, chooseSavePath)

    expect(result.ok).toBe(false)
    expect(result.status).toBe('WRITE_FAILED')
    expect(result.error).toMatch(/^Could not write C:\\Exports\\TestLog-2026-11-14\.xlsx \(EBUSY/)
    expect(result.error).toMatch(/If the file is open in Excel, close it, or export again to another location\.$/)
  })

  it('reports a format with no writer instead of throwing', async () => {
    const result = await service().export({ filter: ALL_RECORDS, format: ExportFormat.CSV }, chooseSavePath)

    expect(result).toMatchObject({ ok: false, status: 'WRITE_FAILED', error: 'Export to CSV is not available yet.' })
    expect(chooseSavePath).not.toHaveBeenCalled()
  })

  it('suggests a .csv name for CSV', () => {
    expect(service().suggestedName(ExportFormat.CSV)).toBe('TestLog-2026-11-14.csv')
  })
})

/** The whole path with a real database and a real workbook: what export:run does after the dialog. */
describe('ExportService end to end', () => {
  let dir: string
  let repository: MetricsRepository

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'harness-export-'))
    repository = await MetricsRepository.open(':memory:')
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    repository.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('exports saved trials and active expert answers to a workbook, leaving the replaced answer out', async () => {
    repository.saveTrial(sampleTrial())
    repository.saveExpert({
      expertId: 'w',
      name: 'Dr. Wong',
      source: ResponseSource.EMAIL,
      outreachTs: '2026-10-06T15:00:00.000Z',
      firstAnswerTs: '2026-11-03T09:30:00.000Z',
      turnaroundMs: 2_399_400_000,
    })
    const answer = { expertId: 'w', sessionId: 'session-a', questionNumber: 7, recordedAt: '2026-11-14T12:00:00.000Z' }
    repository.saveExpertResponse({ ...answer, answerText: 'Original.' })
    repository.saveExpertResponse({ ...answer, answerText: 'Revised.' }, { replace: true })
    const filePath = join(dir, 'TestLog.xlsx')

    const result = await new ExportService({
      repository,
      writers: new Map([[ExportFormat.TESTLOG_V3_XLSX, new TestLogV3Writer()]]),
    }).export(request, async () => filePath)

    expect(result).toEqual({ ok: true, status: 'EXPORTED', filePaths: [filePath], rowCount: 2, error: null })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)
    const sheet = workbook.getWorksheet('Sheet1')
    const column = (col: number): unknown[] => [3, 4, 5].map((row) => sheet?.getRow(row).getCell(col).value ?? null)
    expect(column(2)).toEqual([1, 2, null]) // Test #: the revision kept #2, and there is no third row
    expect(column(4)).toEqual(['DOE Oracle', 'Expert', null])
    expect(column(6)).toEqual(['An answer.', 'Revised.', null])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { ALL_RECORDS, ExportFormat, type ExportRequest, type ExportResult, type RecordFilter } from '../../../shared/export'
import { Subject } from '../../../shared/subjects'
import { createExportHandler, createExportPreviewHandler } from './export'

const exported: ExportResult = { ok: true, status: 'EXPORTED', filePaths: ['out.xlsx'], rowCount: 3, error: null }
const valid: ExportRequest = { filter: ALL_RECORDS, format: ExportFormat.TESTLOG_V3_XLSX }

describe('export:run handler', () => {
  it('runs a valid request through the service with the save dialog', async () => {
    const exportFn = vi.fn(async () => exported)
    const chooseSavePath = vi.fn(async () => 'out.xlsx')
    const handler = createExportHandler(async () => ({ export: exportFn }), chooseSavePath)

    await expect(handler(valid)).resolves.toBe(exported)
    expect(exportFn).toHaveBeenCalledWith(valid, chooseSavePath)
  })

  it('accepts every filter field the Export Page can set', async () => {
    const exportFn = vi.fn(async () => exported)
    const handler = createExportHandler(async () => ({ export: exportFn }), vi.fn())
    const filters = [
      { sessionId: 'session-a', from: null, to: null, subject: null },
      { sessionId: null, from: '2026-11-10T00:00:00.000Z', to: '2026-11-15T00:00:00.000Z', subject: null },
      { sessionId: null, from: null, to: null, subject: Subject.GOOGLE },
      { sessionId: null, from: null, to: null, subject: 'EXPERT' as const },
    ]

    for (const filter of filters) {
      await expect(handler({ filter, format: ExportFormat.CSV })).resolves.toBe(exported)
    }
  })

  it('rejects a malformed request before touching the service', async () => {
    const exportFn = vi.fn(async () => exported)
    const handler = createExportHandler(async () => ({ export: exportFn }), vi.fn())
    const bad = (request: unknown): Promise<ExportResult> => handler(request as ExportRequest)

    await expect(bad(undefined)).rejects.toThrow(/request is missing/)
    await expect(bad({ filter: ALL_RECORDS, format: 'PDF' })).rejects.toThrow(/Unknown export format "PDF"/)
    await expect(bad({ format: ExportFormat.CSV })).rejects.toThrow(/filter is missing/)
    await expect(bad({ filter: { ...ALL_RECORDS, sessionId: 42 }, format: ExportFormat.CSV })).rejects.toThrow(/session filter/)
    await expect(bad({ filter: { ...ALL_RECORDS, from: 'last Tuesday' }, format: ExportFormat.CSV })).rejects.toThrow(/from date/)
    await expect(bad({ filter: { ...ALL_RECORDS, subject: 'BING' }, format: ExportFormat.CSV })).rejects.toThrow(/Unknown subject "BING"/)
    expect(exportFn).not.toHaveBeenCalled()
  })

  it('passes a failed database open through as the error', async () => {
    const handler = createExportHandler(async () => {
      throw new Error('Could not open harness.db')
    }, vi.fn())

    await expect(handler(valid)).rejects.toThrow(/Could not open harness.db/)
  })
})

describe('export:preview handler', () => {
  const counts = { trials: 8, expertAnswers: 12 }

  it('counts a valid filter through the service', async () => {
    const preview = vi.fn(() => counts)
    const handler = createExportPreviewHandler(async () => ({ preview }))
    const filter = { ...ALL_RECORDS, sessionId: 'session-a', subject: Subject.COPILOT }

    await expect(handler(filter)).resolves.toBe(counts)
    expect(preview).toHaveBeenCalledWith(filter)
  })

  it('rejects a malformed filter before touching the service', async () => {
    const preview = vi.fn(() => counts)
    const handler = createExportPreviewHandler(async () => ({ preview }))
    const bad = (filter: unknown): Promise<unknown> => handler(filter as RecordFilter)

    await expect(bad(undefined)).rejects.toThrow(/filter is missing/)
    await expect(bad({ ...ALL_RECORDS, to: 'tomorrow' })).rejects.toThrow(/to date/)
    await expect(bad({ ...ALL_RECORDS, subject: 'BING' })).rejects.toThrow(/Unknown subject "BING"/)
    expect(preview).not.toHaveBeenCalled()
  })

  it('passes a failed database open through as the error', async () => {
    const handler = createExportPreviewHandler(async () => {
      throw new Error('Could not open harness.db')
    })

    await expect(handler(ALL_RECORDS)).rejects.toThrow(/Could not open harness.db/)
  })
})

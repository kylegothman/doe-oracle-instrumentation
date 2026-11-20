import {
  validateExportRequest,
  validateRecordFilter,
  type ExportPreview,
  type ExportRequest,
  type ExportResult,
  type RecordFilter,
} from '../../../shared/export'
import type { ChooseSavePath, ExportService } from '../../data/export-service'

/**
 * Builds the handler for `export:run`. The request is checked first, since
 * it crossed the IPC bridge. The service is supplied through a promise
 * because the database it reads is opened after startup; the save dialog
 * is passed in so tests can stand in for it.
 */
export function createExportHandler(
  service: () => Promise<Pick<ExportService, 'export'>>,
  chooseSavePath: ChooseSavePath,
): (request: ExportRequest) => Promise<ExportResult> {
  return async (request) => {
    const problem = validateExportRequest(request)
    if (problem) throw new Error(problem)
    return (await service()).export(request, chooseSavePath)
  }
}

/**
 * Builds the handler for `export:preview`: how many trials and expert
 * answers the Export Page's filter matches. The filter is checked first,
 * since it crossed the IPC bridge.
 */
export function createExportPreviewHandler(
  service: () => Promise<Pick<ExportService, 'preview'>>,
): (filter: RecordFilter) => Promise<ExportPreview> {
  return async (filter) => {
    const problem = validateRecordFilter(filter)
    if (problem) throw new Error(problem)
    return (await service()).preview(filter)
  }
}

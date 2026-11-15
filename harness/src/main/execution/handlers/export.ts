import { validateExportRequest, type ExportRequest, type ExportResult } from '../../../shared/export'
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

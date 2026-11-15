import type { FailedWriteSummary } from '../../../shared/errors'
import { SUBJECT_LABELS } from '../../../shared/subjects'
import type { ErrorLog, PendingWrite, PendingWriteTarget } from '../../data/error-log'

/** Builds the handler for `errors:list`: the saves waiting for a retry, oldest first. */
export function createListFailedWritesHandler(errorLog: Pick<ErrorLog, 'listPending'>): () => FailedWriteSummary[] {
  return () => errorLog.listPending().map(summarize)
}

/**
 * Builds the handler for `errors:retry`: retries every failed save, oldest
 * first, and returns how many succeeded. The repository is supplied through
 * a promise because the database is opened after startup; if it never
 * opened, the retry reports that error instead.
 */
export function createRetryFailedWritesHandler(
  errorLog: Pick<ErrorLog, 'retryAll'>,
  repository: () => Promise<PendingWriteTarget>,
): () => Promise<number> {
  return async () => {
    const target = await repository()
    const succeeded = errorLog.retryAll(target)
    console.log(`[errors] Retried failed saves: ${succeeded} succeeded`)
    return succeeded
  }
}

/** What the Tester sees for a pending write: what it was, not the whole record. */
function summarize(write: PendingWrite): FailedWriteSummary {
  return {
    id: write.id,
    operation: write.operation,
    description: describe(write),
    error: write.error,
    failedAt: write.failedAt,
  }
}

function describe(write: PendingWrite): string {
  switch (write.operation) {
    case 'saveTrial': {
      const { trial } = write.payload
      return `${SUBJECT_LABELS[trial.subject]} trial, question ${trial.questionNumber}`
    }
    case 'saveExpert':
      return `Expert ${write.payload.expert.name}`
    case 'saveExpertResponse':
      return `Expert answer to question ${write.payload.response.questionNumber}`
  }
}
